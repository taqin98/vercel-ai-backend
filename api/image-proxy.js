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

const ALLOWED_IMAGE_HOSTS = new Set([
  "drive.google.com",
  "docs.google.com",
  "lh3.googleusercontent.com",
  "drive.usercontent.google.com",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "wikimedia.org",
]);

const IMAGE_PROXY_TIMEOUT_MS = 15000;

function parseAllowedOrigins(rawValue) {
  const configuredOrigins = String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set([...DEFAULT_LOCAL_ORIGINS, ...configuredOrigins]);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

function setImageCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isAllowedImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;

  for (const allowedHost of ALLOWED_IMAGE_HOSTS) {
    if (host === allowedHost || host.endsWith(`.${allowedHost}`)) {
      return true;
    }
  }

  return false;
}

function createDriveThumbnailUrl(rawUrl) {
  const url = new URL(rawUrl);
  const directId = url.searchParams.get("id");
  if (url.hostname !== "drive.google.com" && !directId) return rawUrl;

  let fileId = directId || "";
  if (!fileId) {
    const matchers = [
      /\/thumbnail\/d\/([^/?]+)/i,
      /\/file\/d\/([^/?]+)/i,
      /\/d\/([^/?]+)/i,
    ];

    for (const pattern of matchers) {
      const match = url.pathname.match(pattern);
      if (match && match[1]) {
        fileId = match[1];
        break;
      }
    }
  }

  if (!fileId) return rawUrl;

  const width = Number(url.searchParams.get("sz")?.replace(/^w/i, "")) || 400;
  const safeWidth = Math.max(120, Math.min(width, 1000));
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${safeWidth}`;
}

function normalizeUpstreamImageUrl(rawUrl) {
  const parsedUrl = new URL(rawUrl);
  if (
    parsedUrl.hostname === "drive.google.com" ||
    parsedUrl.hostname === "docs.google.com" ||
    parsedUrl.hostname === "drive.usercontent.google.com"
  ) {
    return createDriveThumbnailUrl(rawUrl);
  }

  return rawUrl;
}

async function fetchRemoteImage(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "TOGA-AR-Image-Proxy/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Upstream image request failed (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get("content-type") || "image/jpeg",
      contentLength: response.headers.get("content-length") || "",
      etag: response.headers.get("etag") || "",
      lastModified: response.headers.get("last-modified") || "",
    };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  setImageCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed. Use GET.",
    });
  }

  try {
    const rawUrl = String(req.query?.url || "").trim();
    if (!rawUrl) {
      return res.status(400).json({
        error: "Query 'url' wajib diisi.",
      });
    }

    const parsedUrl = new URL(rawUrl);
    if (!/^https?:$/i.test(parsedUrl.protocol)) {
      return res.status(400).json({
        error: "Protocol URL tidak didukung.",
      });
    }

    if (!isAllowedImageHost(parsedUrl.hostname)) {
      return res.status(403).json({
        error: "Host gambar tidak diizinkan.",
      });
    }

    const upstreamUrl = normalizeUpstreamImageUrl(rawUrl);
    const image = await fetchRemoteImage(upstreamUrl);

    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Cache-Control", "public, s-maxage=86400, max-age=86400");
    if (image.contentLength) {
      res.setHeader("Content-Length", image.contentLength);
    }
    if (image.etag) {
      res.setHeader("ETag", image.etag);
    }
    if (image.lastModified) {
      res.setHeader("Last-Modified", image.lastModified);
    }

    return res.status(200).send(image.buffer);
  } catch (error) {
    const isAbortError =
      error?.name === "AbortError" ||
      /aborted|timeout/i.test(String(error?.message || ""));

    console.error("Image proxy error:", error);
    return res.status(isAbortError ? 504 : 502).json({
      error: isAbortError
        ? "Timeout saat mengambil gambar upstream."
        : "Gagal mengambil gambar upstream.",
    });
  }
}
