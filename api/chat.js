import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const MAX_HISTORY_ITEMS = 10;
const MAX_CONTENT_LENGTH = 4000;

function parseAllowedOrigins(rawValue) {
  return new Set(
    String(rawValue || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
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

export default async function handler(req, res) {
  const corsOk = setCorsHeaders(req, res);

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

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY belum diset di environment Vercel.",
    });
  }

  try {
    const { message, history = [] } = req.body || {};
    const trimmedMessage = sanitizeContent(message);

    if (!trimmedMessage) {
      return res.status(400).json({
        error: "Field 'message' wajib berupa string dan tidak boleh kosong.",
      });
    }

    const safeHistory = sanitizeHistory(history);
    const input = [
      {
        role: "system",
        content:
          "Kamu adalah asisten AI untuk website TOGA. Jawab dalam Bahasa Indonesia, ringkas, jelas, aman, dan membantu. Jika pertanyaan berkaitan dengan kesehatan, jangan memberi diagnosis pasti dan sarankan tenaga kesehatan saat gejala berat atau berbahaya.",
      },
      ...safeHistory,
      {
        role: "user",
        content: trimmedMessage,
      },
    ];

    const response = await client.responses.create({
      model: DEFAULT_MODEL,
      input,
    });

    return res.status(200).json({
      reply: response.output_text || "",
      model: DEFAULT_MODEL,
    });
  } catch (error) {
    console.error("OpenAI error:", error);

    return res.status(500).json({
      error: "Terjadi kesalahan di server.",
      detail: error?.message || "Unknown error",
    });
  }
}
