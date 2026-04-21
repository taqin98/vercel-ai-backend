import {
  createHttpError,
  parseJsonBody,
  sendError,
  setCorsHeaders,
} from "../_auth.js";
import {
  getScheduleEvents,
  handleScheduleOptions,
  mutateSchedule,
  requireScheduleAuth,
} from "../_schedule.js";

function normalizeEventPayload(body) {
  const payload = body && typeof body === "object" ? body : {};
  return {
    id: String(payload.id || "").trim(),
    title: String(payload.title || "").trim(),
    start_date: String(payload.start_date || "").trim(),
    start_time: String(payload.start_time || "").trim(),
    end_date: String(payload.end_date || "").trim(),
    end_time: String(payload.end_time || "").trim(),
    all_day: String(payload.all_day || "0").trim() || "0",
    label_id: String(payload.label_id || "").trim(),
    label_name: String(payload.label_name || "").trim(),
    label_color: String(payload.label_color || "").trim(),
    location: String(payload.location || "").trim(),
    notes: String(payload.notes || "").trim(),
    reminder_minutes: String(payload.reminder_minutes || "").trim(),
    related_plant_id: String(payload.related_plant_id || "").trim(),
    created_by: String(payload.created_by || "").trim(),
  };
}

export default async function handler(req, res) {
  if (handleScheduleOptions(req, res)) return;
  setCorsHeaders(req, res);

  try {
    if (req.method === "GET") {
      const data = await getScheduleEvents(req.query || {});
      return res.status(200).json({
        ok: true,
        events: Array.isArray(data) ? data : [],
      });
    }

    if (req.method === "POST") {
      requireScheduleAuth(req);
      const body = normalizeEventPayload(parseJsonBody(req));
      const result = await mutateSchedule("createEvent", body);
      return res.status(200).json({
        ok: true,
        event: result?.event || null,
      });
    }

    if (req.method === "PUT") {
      requireScheduleAuth(req);
      const body = normalizeEventPayload(parseJsonBody(req));
      if (!body.id) {
        throw createHttpError("ID event wajib diisi.", 400);
      }
      const result = await mutateSchedule("updateEvent", body);
      return res.status(200).json({
        ok: true,
        event: result?.event || null,
      });
    }

    if (req.method === "DELETE") {
      requireScheduleAuth(req);
      const id = String(req.query?.id || "").trim();
      if (!id) {
        throw createHttpError("ID event wajib diisi.", 400);
      }
      await mutateSchedule("deleteEvent", { id });
      return res.status(200).json({ ok: true });
    }

    throw createHttpError("Method not allowed.", 405);
  } catch (error) {
    return sendError(res, error);
  }
}
