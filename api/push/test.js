/**
 * GET /api/push/test
 *
 * Test endpoint — kirim 1 push notification ke semua FCM token terdaftar.
 * Gunakan untuk verifikasi bahwa pipeline FCM berfungsi end-to-end.
 *
 * Contoh: GET /api/push/test?secret=YOUR_CRON_SECRET
 *
 * HAPUS endpoint ini setelah testing selesai.
 */

import { sendError, setCorsHeaders, createHttpError } from "../_auth.js";
import { sendPushBatch } from "../_firebase.js";

const APPS_SCRIPT_TIMEOUT_MS = 12000;

function getAppsScriptApiUrl() {
  const url = String(process.env.APPS_SCRIPT_API_URL || "").trim();
  if (!url) throw createHttpError("APPS_SCRIPT_API_URL belum diatur.", 500);
  return url;
}

function getCronSecret() {
  return String(process.env.CRON_SECRET || "").trim();
}

async function fetchFcmTokens() {
  const apiUrl = new URL(getAppsScriptApiUrl());
  apiUrl.searchParams.set("mode", "fcm-tokens");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  try {
    if (req.method !== "GET") {
      throw createHttpError("Method not allowed.", 405);
    }

    // Basic auth check
    const cronSecret = getCronSecret();
    if (cronSecret) {
      const reqSecret = String(req.query?.secret || "").trim();
      if (reqSecret !== cronSecret) {
        throw createHttpError("Secret tidak valid.", 401);
      }
    }

    // 1. Fetch all registered FCM tokens
    let tokens = [];
    try {
      const result = await fetchFcmTokens();
      const list = Array.isArray(result) ? result : result?.tokens || [];
      tokens = list.map((t) => String(t?.token || t || "").trim()).filter(Boolean);
    } catch (error) {
      return res.status(200).json({
        ok: false,
        error: "Gagal fetch FCM tokens: " + String(error?.message || error),
        hint: "Pastikan Apps Script sudah di-deploy dengan mode=fcm-tokens.",
      });
    }

    if (tokens.length === 0) {
      return res.status(200).json({
        ok: false,
        error: "Tidak ada FCM token terdaftar.",
        hint: "Buka jadwal.html di browser, login, izinkan notifikasi, lalu coba lagi.",
      });
    }

    // 2. Send test notification
    const result = await sendPushBatch(
      tokens,
      "🔔 Test Notifikasi TOGA",
      "Push notification berhasil! Sistem reminder siap digunakan.",
      { event_id: "TEST", click_action: "./jadwal.html" }
    );

    return res.status(200).json({
      ok: true,
      message: "Test push notification terkirim!",
      tokens_found: tokens.length,
      success: result.success,
      failure: result.failure,
      invalid_tokens: result.invalidTokens.length,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
