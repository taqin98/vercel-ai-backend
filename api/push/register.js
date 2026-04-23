/**
 * POST /api/push/register
 *
 * Body: { token: string }
 * Auth: Bearer token required
 *
 * Registers (or updates) an FCM push token for the authenticated user.
 * Tokens are stored in Google Apps Script (sheet "fcm_tokens").
 */

import {
  createHttpError,
  parseJsonBody,
  sendError,
  setCorsHeaders,
} from "../_auth.js";
import {
  handleScheduleOptions,
  mutateSchedule,
  requireScheduleAuth,
} from "../_schedule.js";

export default async function handler(req, res) {
  try {
    if (handleScheduleOptions(req, res)) return;
    setCorsHeaders(req, res);

    if (req.method !== "POST") {
      throw createHttpError("Method not allowed.", 405);
    }

    let user;
    try {
      user = requireScheduleAuth(req);
    } catch (authError) {
      console.error("[push/register] Auth failed:", authError?.message || authError);
      throw createHttpError("Autentikasi gagal: " + String(authError?.message || ""), 401);
    }

    const body = parseJsonBody(req);
    const token = String(body?.token || "").trim();

    if (!token) {
      throw createHttpError("FCM token wajib diisi.", 400);
    }

    const userId = user.id || user.username || user.email || "";
    if (!userId) {
      throw createHttpError("User ID tidak ditemukan dari session.", 400);
    }

    // Save token to Google Apps Script
    try {
      await mutateSchedule("registerFcmToken", {
        user_id: userId,
        token,
        created_at: new Date().toISOString(),
      });
    } catch (scriptError) {
      console.error("[push/register] Apps Script error:", scriptError?.message || scriptError);
      throw createHttpError(
        "Gagal simpan token ke database: " + String(scriptError?.message || ""),
        502
      );
    }

    return res.status(200).json({ ok: true, message: "Token terdaftar." });
  } catch (error) {
    console.error("[push/register] Error:", error?.message || error);
    return sendError(res, error);
  }
}
