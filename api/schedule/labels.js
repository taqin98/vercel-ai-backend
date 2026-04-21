import {
  createHttpError,
  parseJsonBody,
  sendError,
  setCorsHeaders,
} from "../_auth.js";
import {
  getScheduleLabels,
  handleScheduleOptions,
  mutateSchedule,
  requireScheduleAuth,
} from "../_schedule.js";

function normalizeLabelPayload(body) {
  const payload = body && typeof body === "object" ? body : {};
  return {
    id: String(payload.id || "").trim(),
    name: String(payload.name || "").trim(),
    color: String(payload.color || "").trim(),
    sort_order: String(payload.sort_order || "").trim(),
    status: String(payload.status || "").trim(),
    is_default: String(payload.is_default || "").trim(),
  };
}

export default async function handler(req, res) {
  if (handleScheduleOptions(req, res)) return;
  setCorsHeaders(req, res);

  try {
    if (req.method === "GET") {
      const data = await getScheduleLabels();
      return res.status(200).json({
        ok: true,
        labels: Array.isArray(data) ? data : [],
      });
    }

    if (req.method === "POST") {
      requireScheduleAuth(req);
      const body = normalizeLabelPayload(parseJsonBody(req));
      const result = await mutateSchedule("upsertLabel", body);
      return res.status(200).json({
        ok: true,
        label: result?.label || null,
      });
    }

    if (req.method === "PUT") {
      requireScheduleAuth(req);
      const body = normalizeLabelPayload(parseJsonBody(req));
      if (!body.id) {
        throw createHttpError("ID label wajib diisi.", 400);
      }
      const result = await mutateSchedule("upsertLabel", body);
      return res.status(200).json({
        ok: true,
        label: result?.label || null,
      });
    }

    if (req.method === "DELETE") {
      requireScheduleAuth(req);
      const id = String(req.query?.id || "").trim();
      if (!id) {
        throw createHttpError("ID label wajib diisi.", 400);
      }
      await mutateSchedule("deleteLabel", { id });
      return res.status(200).json({ ok: true });
    }

    throw createHttpError("Method not allowed.", 405);
  } catch (error) {
    return sendError(res, error);
  }
}
