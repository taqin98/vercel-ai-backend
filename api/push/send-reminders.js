/**
 * GET /api/push/send-reminders
 *
 * Cron endpoint — called every minute (via Vercel Cron or external cron).
 * Checks for events whose reminder time is NOW and sends push notifications.
 *
 * Optional: pass ?secret=CRON_SECRET as basic auth for external cron services.
 */

import { sendError, setCorsHeaders, createHttpError } from "../_auth.js";
import { sendPushBatch } from "../_firebase.js";

const APPS_SCRIPT_TIMEOUT_MS = 12000;
const REMINDER_WINDOW_MINUTES = 2; // ±2 minute tolerance

function getAppsScriptApiUrl() {
  const url = String(process.env.APPS_SCRIPT_API_URL || "").trim();
  if (!url) {
    throw createHttpError("APPS_SCRIPT_API_URL belum diatur.", 500);
  }
  return url;
}

function getAppsScriptSharedSecret() {
  return String(process.env.APPS_SCRIPT_SHARED_SECRET || "").trim();
}

function getCronSecret() {
  return String(process.env.CRON_SECRET || "").trim();
}

async function fetchAppsScriptJSON(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    const data = await response.json();
    if (!response.ok || data?.ok === false) {
      throw new Error(String(data?.error || `HTTP ${response.status}`));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch events that have reminders due within the current time window.
 */
async function fetchDueReminders() {
  const apiUrl = new URL(getAppsScriptApiUrl());
  apiUrl.searchParams.set("mode", "calendar-due-reminders");
  apiUrl.searchParams.set("window_minutes", String(REMINDER_WINDOW_MINUTES));
  return fetchAppsScriptJSON(apiUrl.toString(), { method: "GET" });
}

/**
 * Fetch all registered FCM tokens.
 */
async function fetchFcmTokens() {
  const apiUrl = new URL(getAppsScriptApiUrl());
  apiUrl.searchParams.set("mode", "fcm-tokens");
  return fetchAppsScriptJSON(apiUrl.toString(), { method: "GET" });
}

/**
 * Mark events as "reminder sent" so we don't re-send.
 */
async function markRemindersSent(eventIds) {
  if (!eventIds.length) return;
  const secret = getAppsScriptSharedSecret();
  return fetchAppsScriptJSON(getAppsScriptApiUrl(), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "markRemindersSent",
      secret,
      payload: { event_ids: eventIds },
    }),
  });
}

function formatReminderText(event) {
  const minutes = Number(event.reminder_minutes) || 0;
  let timeLabel = "";
  if (minutes >= 1440) {
    timeLabel = `${Math.round(minutes / 1440)} hari lagi`;
  } else if (minutes >= 60) {
    timeLabel = `${Math.round(minutes / 60)} jam lagi`;
  } else {
    timeLabel = `${minutes} menit lagi`;
  }

  const location = event.location ? ` — ${event.location}` : "";
  return {
    title: `🔔 ${event.title}`,
    body: `Dimulai ${timeLabel}${location}`,
  };
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  try {
    if (req.method !== "GET") {
      throw createHttpError("Method not allowed.", 405);
    }

    // Basic cron auth: check CRON_SECRET if set
    const cronSecret = getCronSecret();
    if (cronSecret) {
      const reqSecret =
        String(req.query?.secret || "").trim() ||
        String(req.headers["x-cron-secret"] || "").trim();
      // Vercel Cron sends authorization header automatically
      const authHeader = String(req.headers.authorization || "").trim();
      const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";

      if (
        reqSecret !== cronSecret &&
        bearerToken !== cronSecret
      ) {
        throw createHttpError("Cron secret tidak valid.", 401);
      }
    }

    // 1. Fetch events with due reminders
    let dueEvents = [];
    try {
      const result = await fetchDueReminders();
      dueEvents = Array.isArray(result) ? result : result?.events || [];
    } catch (error) {
      console.warn("[cron] fetchDueReminders error:", error?.message || error);
      return res.status(200).json({
        ok: true,
        sent: 0,
        skipped: true,
        reason: "fetchDueReminders gagal: " + String(error?.message || error),
      });
    }

    if (dueEvents.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: "Tidak ada reminder yang jatuh tempo." });
    }

    // 2. Fetch all FCM tokens
    let tokens = [];
    try {
      const result = await fetchFcmTokens();
      tokens = Array.isArray(result) ? result : result?.tokens || [];
    } catch (error) {
      console.warn("[cron] fetchFcmTokens error:", error?.message || error);
      return res.status(200).json({
        ok: true,
        sent: 0,
        skipped: true,
        reason: "fetchFcmTokens gagal: " + String(error?.message || error),
      });
    }

    const tokenStrings = tokens
      .map((t) => String(t?.token || t || "").trim())
      .filter(Boolean);

    if (tokenStrings.length === 0) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        message: "Tidak ada FCM token terdaftar.",
      });
    }

    // 3. Send push for each due event
    let totalSent = 0;
    const sentEventIds = [];

    for (const event of dueEvents) {
      const { title, body } = formatReminderText(event);
      const data = {
        event_id: String(event.id || ""),
        click_action: "./jadwal.html",
      };

      const result = await sendPushBatch(tokenStrings, title, body, data);
      totalSent += result.success;

      if (result.success > 0) {
        sentEventIds.push(String(event.id || ""));
      }
    }

    // 4. Mark reminders as sent
    if (sentEventIds.length > 0) {
      try {
        await markRemindersSent(sentEventIds);
      } catch (error) {
        console.warn("[cron] markRemindersSent error:", error?.message || error);
      }
    }

    return res.status(200).json({
      ok: true,
      sent: totalSent,
      events: sentEventIds.length,
      message: `${totalSent} notifikasi terkirim untuk ${sentEventIds.length} event.`,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
