import {
  createHttpError,
  getBearerToken,
  getAppsScriptSharedSecret,
  setCorsHeaders,
  verifySessionToken,
} from "./_auth.js";

const APPS_SCRIPT_TIMEOUT_MS = 15000;

function getAppsScriptApiUrl() {
  const url = String(process.env.APPS_SCRIPT_API_URL || "").trim();
  if (!url) {
    throw createHttpError("APPS_SCRIPT_API_URL belum diatur di backend.", 500);
  }
  return url;
}

async function fetchAppsScript(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      throw createHttpError("Respons Apps Script bukan JSON yang valid.", 502);
    }

    if (!response.ok) {
      throw createHttpError(
        String(data?.error || `Apps Script gagal (${response.status}).`),
        response.status >= 400 && response.status < 600 ? response.status : 502
      );
    }

    if (data && typeof data === "object" && data.ok === false && data.error) {
      throw createHttpError(String(data.error), 502);
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createHttpError("Apps Script timeout.", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function getScheduleEvents(params) {
  const apiUrl = new URL(getAppsScriptApiUrl());
  apiUrl.searchParams.set("mode", "calendar-events");

  const from = String(params?.from || "").trim();
  const to = String(params?.to || "").trim();
  const labelId = String(params?.label_id || "").trim();

  if (from) apiUrl.searchParams.set("from", from);
  if (to) apiUrl.searchParams.set("to", to);
  if (labelId) apiUrl.searchParams.set("label_id", labelId);

  return fetchAppsScript(apiUrl.toString(), { method: "GET" });
}

export async function getScheduleLabels() {
  const apiUrl = new URL(getAppsScriptApiUrl());
  apiUrl.searchParams.set("mode", "calendar-labels");
  return fetchAppsScript(apiUrl.toString(), { method: "GET" });
}

export async function mutateSchedule(action, payload) {
  const secret = getAppsScriptSharedSecret();
  return fetchAppsScript(getAppsScriptApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify({
      action,
      secret,
      payload,
    }),
  });
}

export function requireScheduleAuth(req) {
  const token = getBearerToken(req);
  return verifySessionToken(token);
}

export function handleScheduleOptions(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return true;
  }
  return false;
}
