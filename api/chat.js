const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openrouter/auto";
const MAX_HISTORY_ITEMS = 10;
const MAX_CONTENT_LENGTH = 4000;
const MAX_CONTEXT_ITEMS = 6;
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

function parseAllowedOrigins(rawValue) {
  const configuredOrigins = String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set([...DEFAULT_LOCAL_ORIGINS, ...configuredOrigins]);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

function sanitizeContent(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_CONTENT_LENGTH);
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
    )
    .slice(-MAX_HISTORY_ITEMS)
    .map((item) => ({
      role: item.role,
      content: sanitizeContent(item.content),
    }))
    .filter((item) => item.content);
}

function sanitizeContextList(list, itemSanitizer) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_CONTEXT_ITEMS).map(itemSanitizer).filter(Boolean);
}

function sanitizePlantContextItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: sanitizeContent(item.id),
    nama: sanitizeContent(item.nama),
    nama_latin: sanitizeContent(item.nama_latin),
    jenis: sanitizeContent(item.jenis),
    manfaat: sanitizeContextList(item.manfaat, sanitizeContent),
    catatan: sanitizeContextList(item.catatan, sanitizeContent),
    deskripsi: sanitizeContent(item.deskripsi),
  };
}

function sanitizeGalleryContextItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: sanitizeContent(item.id),
    title: sanitizeContent(item.title),
    date: sanitizeContent(item.date),
    location: sanitizeContent(item.location),
    person: sanitizeContent(item.person),
    desc: sanitizeContent(item.desc),
  };
}

function sanitizeRemedyContextItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: sanitizeContent(item.id),
    judul: sanitizeContent(item.judul),
    kategori: sanitizeContent(item.kategori),
    tanaman: sanitizeContextList(item.tanaman, sanitizeContent),
    ringkas: sanitizeContent(item.ringkas),
    langkah: sanitizeContextList(item.langkah, sanitizeContent),
    perhatian: sanitizeContent(item.perhatian),
  };
}

function sanitizeContext(context) {
  if (!context || typeof context !== "object") return null;

  const page = sanitizeContent(context.page).toLowerCase();
  const view = sanitizeContent(context.view).toLowerCase();
  const title = sanitizeContent(context.title);
  const query = sanitizeContent(context.query);
  const selectedJenis = sanitizeContent(context.selectedJenis);
  const intro = sanitizeContent(context.intro);

  return {
    page,
    view,
    title,
    query,
    selectedJenis,
    intro,
    totalItems: Number.isFinite(Number(context.totalItems))
      ? Number(context.totalItems)
      : undefined,
    filteredItems: Number.isFinite(Number(context.filteredItems))
      ? Number(context.filteredItems)
      : undefined,
    currentItem:
      page === "tanaman"
        ? sanitizePlantContextItem(context.currentItem)
        : page === "gallery"
        ? sanitizeGalleryContextItem(context.currentItem)
        : page === "ramuan"
        ? sanitizeRemedyContextItem(context.currentItem)
        : null,
    visibleItems:
      page === "tanaman"
        ? sanitizeContextList(context.visibleItems, sanitizePlantContextItem)
        : page === "gallery"
        ? sanitizeContextList(context.visibleItems, sanitizeGalleryContextItem)
        : [],
    remedies:
      page === "ramuan"
        ? sanitizeContextList(context.remedies, sanitizeRemedyContextItem)
        : [],
  };
}

function buildSystemPrompt(context) {
  const basePrompt =
    "Kamu adalah asisten AI untuk website TOGA. Jawab dalam Bahasa Indonesia, ringkas, jelas, aman, dan membantu. Jika pertanyaan berkaitan dengan kesehatan, jangan memberi diagnosis pasti, jangan menggantikan tenaga kesehatan, dan sarankan pemeriksaan medis saat gejala berat, mendadak, berkepanjangan, atau berbahaya.";

  if (!context || !context.page) {
    return basePrompt;
  }

  if (context.page === "ramuan") {
    return `${basePrompt} Fokus pada ramuan TOGA, tanaman yang relevan, langkah sederhana, cara penggunaan dasar, dan peringatan umum. Jika bahan atau tanaman tidak ada di konteks, katakan dengan jujur. Jangan membuat klaim medis pasti.`;
  }

  if (context.page === "tanaman") {
    return `${basePrompt} Fokus pada tanaman TOGA yang sedang dibuka atau terlihat di daftar. Gunakan konteks tanaman aktif bila tersedia, jelaskan manfaat, penggunaan dasar, dan catatan kehati-hatian secara praktis.`;
  }

  if (context.page === "gallery") {
    return `${basePrompt} Fokus pada galeri kegiatan TOGA. Jawab dengan merangkum kegiatan, menjelaskan manfaat kegiatan untuk warga, atau menjelaskan isi dokumentasi yang sedang dibuka.`;
  }

  return basePrompt;
}

function buildContextMessage(context) {
  if (!context || !context.page) return null;

  const compact = {
    page: context.page,
    view: context.view,
    title: context.title,
    query: context.query,
    selectedJenis: context.selectedJenis,
    totalItems: context.totalItems,
    filteredItems: context.filteredItems,
    intro: context.intro,
    currentItem: context.currentItem,
    visibleItems: context.visibleItems,
    remedies: context.remedies,
  };

  return {
    role: "system",
    content: `Gunakan konteks halaman berikut bila relevan:\n${JSON.stringify(compact)}`,
  };
}

function buildMessages(message, history, context) {
  const contextMessage = buildContextMessage(context);

  return [
    {
      role: "system",
      content: buildSystemPrompt(context),
    },
    ...(contextMessage ? [contextMessage] : []),
    ...history,
    {
      role: "user",
      content: message,
    },
  ];
}

function pickReferer(origin) {
  const envSiteUrl = sanitizeContent(process.env.OPENROUTER_SITE_URL);
  if (envSiteUrl) return envSiteUrl;
  if (/^https?:\/\//i.test(origin)) return origin;

  const firstAllowed = Array.from(ALLOWED_ORIGINS).find((item) =>
    /^https?:\/\//i.test(item)
  );
  return firstAllowed || "";
}

function buildOpenRouterHeaders(origin) {
  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };

  const referer = pickReferer(origin);
  const title =
    sanitizeContent(process.env.OPENROUTER_APP_NAME) || "TOGA RT 09";

  if (referer) {
    headers["HTTP-Referer"] = referer;
  }

  if (title) {
    headers["X-Title"] = title;
  }

  return headers;
}

function extractReplyText(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

async function sendOpenRouterChat(messages, origin) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders(origin),
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      data?.error?.message ||
      data?.message ||
      `OpenRouter request failed with HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }

  return {
    reply: extractReplyText(data),
    raw: data,
  };
}

export default async function handler(req, res) {
  const corsOk = setCorsHeaders(req, res);
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    return corsOk ? res.status(200).end() : res.status(403).end();
  }

  if (!corsOk) {
    return res.status(403).json({
      error: "Origin tidak diizinkan.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST.",
    });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({
      error: "OPENROUTER_API_KEY belum diset di environment Vercel.",
    });
  }

  try {
    const { message, history = [], context = null } = req.body || {};
    const trimmedMessage = sanitizeContent(message);

    if (!trimmedMessage) {
      return res.status(400).json({
        error: "Field 'message' wajib berupa string dan tidak boleh kosong.",
      });
    }

    const safeHistory = sanitizeHistory(history);
    const safeContext = sanitizeContext(context);
    const messages = buildMessages(trimmedMessage, safeHistory, safeContext);
    const result = await sendOpenRouterChat(messages, origin);

    return res.status(200).json({
      reply: result.reply || "",
      model: DEFAULT_MODEL,
      provider: "openrouter",
    });
  } catch (error) {
    console.error("OpenRouter error:", error);

    return res.status(error?.status || 500).json({
      error: "Terjadi kesalahan di server.",
      detail: error?.message || "Unknown error",
      provider: "openrouter",
    });
  }
}
