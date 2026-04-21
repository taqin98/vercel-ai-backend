import {
  authenticatePassword,
  buildSession,
  createHttpError,
  handleOptions,
  parseJsonBody,
  sendError,
  setCorsHeaders,
} from "../_auth.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCorsHeaders(req, res);

  if (req.method !== "POST") {
    return sendError(res, createHttpError("Method not allowed. Use POST.", 405));
  }

  try {
    const body = parseJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (!username || !password) {
      throw createHttpError("Username dan password wajib diisi.", 400);
    }

    const user = authenticatePassword(username, password);
    const session = buildSession(user);
    return res.status(200).json({
      ok: true,
      token: session.token,
      user: session.user,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
