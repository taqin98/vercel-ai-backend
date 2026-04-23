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
  if (handleScheduleOptions(req, res)) return;
  setCorsHeaders(req, res);

  try {
    if (req.method !== "POST") {
      throw createHttpError("Method not allowed.", 405);
    }

    const user = requireScheduleAuth(req);
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
    await mutateSchedule("registerFcmToken", {
      user_id: userId,
      token,
      created_at: new Date().toISOString(),
    });

    return res.status(200).json({ ok: true, message: "Token terdaftar." });
  } catch (error) {
    return sendError(res, error);
  }
}
