import {
  createHttpError,
  handleOptions,
  sendError,
  setCorsHeaders,
} from "../_auth.js";

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCorsHeaders(req, res);

  if (req.method !== "POST") {
    return sendError(res, createHttpError("Method not allowed. Use POST.", 405));
  }

  return res.status(200).json({
    ok: true,
  });
}
