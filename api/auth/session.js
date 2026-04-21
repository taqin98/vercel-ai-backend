import {
  createHttpError,
  getBearerToken,
  handleOptions,
  sendError,
  setCorsHeaders,
  verifySessionToken,
} from "../_auth.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCorsHeaders(req, res);

  if (req.method !== "GET") {
    return sendError(res, createHttpError("Method not allowed. Use GET.", 405));
  }

  try {
    const token = getBearerToken(req);
    const user = verifySessionToken(token);
    return res.status(200).json({
      ok: true,
      user,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
