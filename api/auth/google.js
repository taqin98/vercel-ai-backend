import {
  buildSession,
  createHttpError,
  handleOptions,
  parseJsonBody,
  sendError,
  setCorsHeaders,
  verifyGoogleCredential,
} from "../_auth.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCorsHeaders(req, res);

  if (req.method !== "POST") {
    return sendError(res, createHttpError("Method not allowed. Use POST.", 405));
  }

  try {
    const body = parseJsonBody(req);
    const credential = String(body.credential || "").trim();
    if (!credential) {
      throw createHttpError("Credential Google wajib diisi.", 400);
    }

    const user = await verifyGoogleCredential(credential);
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
