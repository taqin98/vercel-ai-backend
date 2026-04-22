import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_LOCAL_ORIGINS = [
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
];

const TOKEN_VERIFY_TIMEOUT_MS = 10000;
const APPS_SCRIPT_WRITE_TIMEOUT_MS = 10000;
const DEFAULT_TOKEN_TTL_SEC = 60 * 60 * 24 * 7;
const PROXIED_AVATAR_HOSTS = new Set([
  "lh3.googleusercontent.com",
  "googleusercontent.com",
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
]);

function parseAllowedOrigins(rawValue) {
  const configuredOrigins = String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set([...DEFAULT_LOCAL_ORIGINS, ...configuredOrigins]);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

export function setCorsHeaders(req, res) {
  const origin = String(req.headers.origin || "").trim();
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function handleOptions(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return true;
  }
  return false;
}

export function createHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function sendError(res, error) {
  const status = Number(error?.status || 500);
  const message = String(error?.message || "Terjadi kesalahan.");
  return res.status(status).json({ ok: false, error: message });
}

export function parseJsonBody(req) {
  if (!req || !("body" in req)) return {};
  const body = req.body;
  if (!body) return {};
  if (typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (_) {
      throw createHttpError("Body JSON tidak valid.", 400);
    }
  }
  return {};
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRequestOrigin(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").trim();
  const host = String(req?.headers?.host || "").trim();
  if (forwardedProto && host) {
    return `${forwardedProto}://${host}`;
  }

  const vercelUrl = String(process.env.VERCEL_URL || "").trim();
  if (vercelUrl) {
    return `https://${vercelUrl}`;
  }

  return host ? `http://${host}` : "";
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function shouldProxyAvatarUrl(value) {
  const rawUrl = String(value || "").trim();
  if (!rawUrl || !isHttpUrl(rawUrl)) return false;

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    for (const allowedHost of PROXIED_AVATAR_HOSTS) {
      if (host === allowedHost || host.endsWith(`.${allowedHost}`)) {
        return true;
      }
    }
  } catch (_) {
    return false;
  }

  return false;
}

export function withProxiedUserAvatar(req, user) {
  if (!user || typeof user !== "object") return user;

  const avatar = String(user.avatar || "").trim();
  if (!shouldProxyAvatarUrl(avatar)) {
    return user;
  }

  const origin = buildRequestOrigin(req);
  if (!origin) {
    return user;
  }

  return {
    ...user,
    avatar: `${origin}/api/image-proxy?url=${encodeURIComponent(avatar)}`,
  };
}

function parseAuthUsers() {
  const rawJson = String(process.env.AUTH_USERS_JSON || "").trim();
  if (!rawJson) return [];

  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const username = String(item.username || "").trim();
        const password = String(item.password || "");
        if (!username || !password) return null;
        return {
          username,
          password,
          email: String(item.email || "").trim().toLowerCase(),
          displayName:
            String(item.displayName || item.name || username).trim() || username,
          role: String(item.role || "editor").trim() || "editor",
        };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

const AUTH_USERS = parseAuthUsers();

export function authenticatePassword(username, password) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  const cleanPassword = String(password || "");

  const matched = AUTH_USERS.find((user) => {
    return (
      String(user.username || "").trim().toLowerCase() === cleanUsername &&
      String(user.password || "") === cleanPassword
    );
  });

  if (!matched) {
    throw createHttpError("Username atau password tidak cocok.", 401);
  }

  return {
    id: matched.username,
    username: matched.username,
    email: matched.email,
    displayName: matched.displayName,
    role: matched.role,
    provider: "password",
  };
}

function getAuthSecret() {
  const secret = String(process.env.AUTH_JWT_SECRET || "").trim();
  if (!secret) {
    throw createHttpError("AUTH_JWT_SECRET belum diatur di environment.", 500);
  }
  return secret;
}

export function getAppsScriptSharedSecret() {
  const secret = String(process.env.APPS_SCRIPT_SHARED_SECRET || "").trim();
  if (!secret) {
    throw createHttpError("APPS_SCRIPT_SHARED_SECRET belum diatur di backend.", 500);
  }
  return secret;
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(input || "").length / 4) * 4, "=");
  return Buffer.from(normalized, "base64");
}

function signInput(value, secret) {
  return createHmac("sha256", secret).update(value).digest();
}

function createToken(payload) {
  const secret = getAuthSecret();
  const header = { alg: "HS256", typ: "JWT" };
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = parsePositiveInt(process.env.AUTH_TOKEN_TTL_SEC, DEFAULT_TOKEN_TTL_SEC);
  const claims = {
    ...payload,
    iat: nowSec,
    exp: nowSec + ttlSec,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlEncode(signInput(signingInput, secret));
  return `${signingInput}.${signature}`;
}

function decodeToken(token) {
  const secret = getAuthSecret();
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw createHttpError("Token auth tidak valid.", 401);
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = signInput(signingInput, secret);
  const actualSignature = base64UrlDecode(encodedSignature);

  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    throw createHttpError("Signature token auth tidak valid.", 401);
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  } catch (_) {
    throw createHttpError("Payload token auth tidak valid.", 401);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload !== "object" || Number(payload.exp || 0) < nowSec) {
    throw createHttpError("Session login sudah kedaluwarsa.", 401);
  }

  return payload;
}

export function buildSession(user) {
  const safeUser = {
    id: String(user.id || user.username || user.email || "").trim(),
    username: String(user.username || "").trim(),
    email: String(user.email || "").trim(),
    displayName:
      String(user.displayName || user.name || user.username || user.email || "Pengguna").trim() ||
      "Pengguna",
    role: String(user.role || "editor").trim() || "editor",
    provider: String(user.provider || "password").trim() || "password",
    avatar: String(user.avatar || "").trim(),
  };

  if (!safeUser.id) {
    throw createHttpError("User session tidak valid.", 500);
  }

  const token = createToken({
    sub: safeUser.id,
    username: safeUser.username,
    email: safeUser.email,
    displayName: safeUser.displayName,
    role: safeUser.role,
    provider: safeUser.provider,
    avatar: safeUser.avatar,
  });

  return {
    token,
    user: {
      ...safeUser,
      loginAt: Date.now(),
    },
  };
}

async function appendLoginLogToAppsScript(payload) {
  const apiUrl = String(process.env.APPS_SCRIPT_API_URL || "").trim();
  if (!apiUrl) return false;
  const secret = getAppsScriptSharedSecret();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPS_SCRIPT_WRITE_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify({
        action: "appendLoginLog",
        secret,
        payload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Apps Script HTTP ${response.status}`);
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (data && data.ok === false) {
      throw new Error(String(data.error || "Apps Script menolak appendLoginLog."));
    }

    return true;
  } finally {
    clearTimeout(timer);
  }
}

export async function recordLoginEvent(req, sessionUser) {
  const forwardedFor = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const realIp = String(req?.headers?.["x-real-ip"] || "").trim();
  const userAgent = String(req?.headers?.["user-agent"] || "").trim();
  const loginAt = Number(sessionUser?.loginAt || Date.now()) || Date.now();

  const payload = {
    event: "auth_login_success",
    timestamp_login: new Date(loginAt).toISOString(),
    provider: String(sessionUser?.provider || "").trim(),
    user_id: String(sessionUser?.id || "").trim(),
    username: String(sessionUser?.username || "").trim(),
    email: String(sessionUser?.email || "").trim(),
    display_name: String(sessionUser?.displayName || "").trim(),
    role: String(sessionUser?.role || "").trim(),
    ip: forwardedFor || realIp,
    user_agent: userAgent,
  };

  console.info("[auth]", JSON.stringify(payload));
  try {
    await appendLoginLogToAppsScript(payload);
  } catch (error) {
    console.warn("[auth] appendLoginLog failed:", String(error?.message || error));
  }
  return payload;
}

export function getBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    throw createHttpError("Token Authorization diperlukan.", 401);
  }
  return match[1];
}

export function verifySessionToken(token) {
  const payload = decodeToken(token);
  return {
    id: String(payload.sub || "").trim(),
    username: String(payload.username || "").trim(),
    email: String(payload.email || "").trim(),
    displayName: String(payload.displayName || "").trim(),
    role: String(payload.role || "editor").trim() || "editor",
    provider: String(payload.provider || "password").trim() || "password",
    avatar: String(payload.avatar || "").trim(),
    loginAt: Number(payload.iat || 0) * 1000 || Date.now(),
  };
}

function getAllowedGoogleEmails() {
  return new Set(
    String(process.env.AUTH_ALLOWED_GOOGLE_EMAILS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function verifyGoogleCredential(idToken) {
  const token = String(idToken || "").trim();
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  if (!token) {
    throw createHttpError("Credential Google wajib diisi.", 400);
  }
  if (!clientId) {
    throw createHttpError("GOOGLE_CLIENT_ID belum diatur di backend.", 500);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`,
      {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      throw createHttpError("Token Google tidak valid.", 401);
    }

    const payload = await response.json();
    const email = String(payload.email || "").trim().toLowerCase();
    const audience = String(payload.aud || "").trim();
    const emailVerified = String(payload.email_verified || "").trim().toLowerCase() === "true";

    if (!email || !emailVerified) {
      throw createHttpError("Akun Google belum terverifikasi.", 401);
    }

    if (audience !== clientId) {
      throw createHttpError("Audience Google token tidak cocok.", 401);
    }

    const allowedEmails = getAllowedGoogleEmails();
    if (allowedEmails.size > 0 && !allowedEmails.has(email)) {
      throw createHttpError("Akun Google ini belum diizinkan.", 403);
    }

    return {
      id: String(payload.sub || email).trim(),
      email,
      displayName:
        String(payload.name || payload.given_name || payload.email || "Pengguna").trim() ||
        "Pengguna",
      role: "editor",
      provider: "google",
      avatar: String(payload.picture || "").trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}
