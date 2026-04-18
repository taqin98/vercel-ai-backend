import { isIP } from "node:net";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const FALLBACK_MODELS = String(
  process.env.OPENROUTER_FALLBACK_MODELS ||
    process.env.OPENROUTER_MODELS ||
    ""
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const MAX_HISTORY_ITEMS = 10;
const MAX_CONTENT_LENGTH = 4000;
const MAX_CONTEXT_ITEMS = 6;
const MAX_KNOWLEDGE_ITEMS = 8;
const MAX_CONTEXT_FIELDS = 24;
const MAX_DATASET_FIELD_ITEMS = 8;
const DATA_SOURCE_TIMEOUT_MS = 8000;
const DATA_SOURCE_CACHE_TTL_MS = 10 * 60 * 1000;
const OPENROUTER_TIMEOUT_MS = 14000;
const OPENROUTER_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const OPENROUTER_RETRY_DELAY_MS = 600;
const MAX_OUTPUT_TOKENS = 500;
const DEFAULT_FUNCTION_TIMEOUT_MS = 10000;
const RESPONSE_HEADROOM_MS = 1200;
const MIN_STAGE_TIMEOUT_MS = 1500;
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
const DATASET_CACHE = new Map();

function parseAllowedOrigins(rawValue) {
  const configuredOrigins = String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set([...DEFAULT_LOCAL_ORIGINS, ...configuredOrigins]);
}

function parseAllowedDataSourceKeys(rawValue) {
  return new Set(
    String(rawValue || "")
      .split(",")
      .map((item) => getDataSourceKey(item))
      .filter(Boolean)
  );
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const ALLOWED_DATA_SOURCE_KEYS = parseAllowedDataSourceKeys(
  process.env.ALLOWED_DATA_SOURCE_URLS
);

function createHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(rawValue, fallback) {
  const value = Number.parseInt(String(rawValue || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const FUNCTION_TIMEOUT_MS = parsePositiveInt(
  process.env.FUNCTION_TIMEOUT_MS || process.env.VERCEL_FUNCTION_TIMEOUT_MS,
  DEFAULT_FUNCTION_TIMEOUT_MS
);
const FUNCTION_BUDGET_MS = Math.max(
  FUNCTION_TIMEOUT_MS - RESPONSE_HEADROOM_MS,
  MIN_STAGE_TIMEOUT_MS * 2
);

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

function sanitizeContextList(list, itemSanitizer, limit = MAX_CONTEXT_ITEMS) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, limit).map(itemSanitizer).filter(Boolean);
}

function sanitizeFieldValue(value) {
  if (Array.isArray(value)) {
    return sanitizeContextList(value, sanitizeContent, MAX_DATASET_FIELD_ITEMS);
  }

  return sanitizeContent(value);
}

function sanitizeFieldMap(fields) {
  if (!fields || typeof fields !== "object") return {};

  return Object.entries(fields)
    .slice(0, MAX_CONTEXT_FIELDS)
    .reduce((acc, [key, value]) => {
      const safeKey = sanitizeContent(key);
      if (!safeKey) return acc;

      const safeValue = sanitizeFieldValue(value);
      const isEmptyArray = Array.isArray(safeValue) && safeValue.length === 0;

      if (!safeValue || isEmptyArray) return acc;

      acc[safeKey] = safeValue;
      return acc;
    }, {});
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
    fields: sanitizeFieldMap(item.fields),
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

function sanitizeKnowledgeTypeItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    jenis: sanitizeContent(item.jenis),
    jumlah: Number.isFinite(Number(item.jumlah)) ? Number(item.jumlah) : 0,
  };
}

function sanitizeKnowledgeBase(base) {
  if (!base || typeof base !== "object") return null;

  return {
    source: sanitizeContent(base.source),
    note: sanitizeContent(base.note),
    matchType: sanitizeContent(base.matchType),
    matchReason: sanitizeContent(base.matchReason),
    totalItems: Number.isFinite(Number(base.totalItems))
      ? Number(base.totalItems)
      : undefined,
    availableFields: sanitizeContextList(
      base.availableFields,
      sanitizeContent,
      MAX_CONTEXT_FIELDS
    ),
    queryTerms: sanitizeContextList(
      base.queryTerms,
      sanitizeContent,
      MAX_CONTEXT_FIELDS
    ),
    columns: sanitizeContextList(
      base.columns,
      sanitizeContent,
      MAX_CONTEXT_FIELDS
    ),
    jenisSummary: sanitizeContextList(
      base.jenisSummary,
      sanitizeKnowledgeTypeItem
    ),
    items: sanitizeContextList(
      base.items,
      sanitizePlantContextItem,
      MAX_KNOWLEDGE_ITEMS
    ),
    matchedItem: sanitizePlantContextItem(base.matchedItem),
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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDatasetScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().slice(0, MAX_CONTENT_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().slice(0, MAX_CONTENT_LENGTH);
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, MAX_CONTENT_LENGTH);
    } catch (_) {
      return "";
    }
  }

  return "";
}

function normalizeDatasetFieldValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeDatasetScalar(item))
      .filter(Boolean)
      .slice(0, MAX_DATASET_FIELD_ITEMS);
  }

  return normalizeDatasetScalar(value);
}

function collectDatasetFields(raw) {
  if (!raw || typeof raw !== "object") return {};

  return Object.entries(raw)
    .slice(0, MAX_CONTEXT_FIELDS)
    .reduce((acc, [key, value]) => {
      const safeKey = sanitizeContent(String(key || ""));
      if (!safeKey) return acc;

      const normalizedValue = normalizeDatasetFieldValue(value);
      const isEmptyArray =
        Array.isArray(normalizedValue) && normalizedValue.length === 0;

      if (!normalizedValue || isEmptyArray) return acc;

      acc[safeKey] = normalizedValue;
      return acc;
    }, {});
}

function getFirstFieldValue(raw, keys) {
  if (!raw || typeof raw !== "object") return "";

  for (const key of keys) {
    const value = normalizeDatasetScalar(raw[key]);
    if (value) return value;
  }

  return "";
}

function flattenFieldMap(fields) {
  return Object.entries(fields || {}).flatMap(([key, value]) =>
    Array.isArray(value) ? [key, ...value] : [key, value]
  );
}

function normalizeKnowledgeItem(raw, index) {
  if (!raw || typeof raw !== "object") return null;

  const fields = collectDatasetFields(raw);
  if (Object.keys(fields).length === 0) return null;

  const id =
    getFirstFieldValue(raw, ["id", "slug", "kode", "code"]) ||
    `item-${index + 1}`;
  const nama = getFirstFieldValue(raw, ["nama", "judul", "title", "name"]);
  const namaLatin = getFirstFieldValue(raw, [
    "nama_latin",
    "latin",
    "namaLatin",
  ]);
  const jenis = getFirstFieldValue(raw, ["jenis", "kategori", "category"]);
  const deskripsi = getFirstFieldValue(raw, [
    "deskripsi",
    "ringkas",
    "desc",
    "description",
  ]);

  return {
    id,
    nama: nama || id,
    nama_latin: namaLatin,
    jenis,
    deskripsi,
    manfaat: Array.isArray(fields.manfaat) ? fields.manfaat : [],
    catatan: Array.isArray(fields.catatan) ? fields.catatan : [],
    fields,
    searchText: normalizeText(flattenFieldMap(fields).join(" ")),
  };
}

function normalizeKnowledgeDataset(data) {
  if (Array.isArray(data)) {
    return data.map(normalizeKnowledgeItem).filter(Boolean);
  }

  if (data && typeof data === "object" && Array.isArray(data.data)) {
    return data.data.map(normalizeKnowledgeItem).filter(Boolean);
  }

  if (data && typeof data === "object") {
    return Object.values(data).map(normalizeKnowledgeItem).filter(Boolean);
  }

  return [];
}

function getDataSourceKey(rawUrl) {
  try {
    const url = new URL(String(rawUrl || "").trim());
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}

function isPrivateHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".local")) return true;

  const version = isIP(normalized);
  if (!version) return false;

  if (version === 4) {
    const [a, b] = normalized.split(".").map((part) => Number(part));
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80")
  );
}

function normalizeDataSourceUrl(rawUrl) {
  const value = sanitizeContent(rawUrl);
  if (!value) return "";

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw createHttpError("URL sumber data AI tidak valid.", 400);
  }

  if (url.protocol !== "https:") {
    throw createHttpError("Sumber data AI harus memakai HTTPS.", 400);
  }

  if (isPrivateHostname(url.hostname)) {
    throw createHttpError(
      "Sumber data AI tidak boleh mengarah ke host lokal atau private network.",
      400
    );
  }

  const key = getDataSourceKey(url.toString());
  if (
    ALLOWED_DATA_SOURCE_KEYS.size > 0 &&
    key &&
    !ALLOWED_DATA_SOURCE_KEYS.has(key)
  ) {
    throw createHttpError("Sumber data AI tidak diizinkan.", 403);
  }

  url.searchParams.set("mode", "list");
  return url.toString();
}

function sanitizeDataSource(dataSource) {
  if (!dataSource || typeof dataSource !== "object") return null;

  const url = normalizeDataSourceUrl(dataSource.url);
  if (!url) return null;

  return {
    url,
    mode: "list",
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = DATA_SOURCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw createHttpError(
        data?.error ||
          data?.message ||
          `Gagal mengambil dataset AI dari sumber data (HTTP ${response.status}).`,
        502
      );
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createHttpError(
        `Sumber data AI tidak merespons dalam ${timeoutMs} ms.`,
        504
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getRemainingBudgetMs(startedAtMs) {
  return Math.max(FUNCTION_BUDGET_MS - (Date.now() - startedAtMs), 0);
}

function clampStageTimeout(requestedMs, remainingBudgetMs) {
  const bounded = Math.min(requestedMs, remainingBudgetMs);
  return Math.max(Math.floor(bounded), MIN_STAGE_TIMEOUT_MS);
}

async function loadKnowledgeDataset(
  dataSource,
  timeoutMs = DATA_SOURCE_TIMEOUT_MS
) {
  if (!dataSource?.url) return [];

  const now = Date.now();
  const cached = DATASET_CACHE.get(dataSource.url);
  if (cached && now - cached.ts <= DATA_SOURCE_CACHE_TTL_MS) {
    return cached.data;
  }

  const payload = await fetchJsonWithTimeout(dataSource.url, timeoutMs);
  const dataset = normalizeKnowledgeDataset(payload);

  if (dataset.length === 0) {
    throw createHttpError(
      "Dataset AI berhasil diambil, tetapi tidak ada record yang bisa dipakai.",
      502
    );
  }

  DATASET_CACHE.set(dataSource.url, {
    ts: now,
    data: dataset,
  });

  return dataset;
}

function buildJenisSummary(items) {
  const counts = new Map();

  items.forEach((item) => {
    const key = sanitizeContent(item.jenis) || "Lainnya";
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(([jenis, jumlah]) => ({ jenis, jumlah }));
}

function buildKnowledgeColumns(items) {
  const keys = new Set();

  items.forEach((item) => {
    Object.keys(item.fields || {}).forEach((key) => keys.add(key));
  });

  return Array.from(keys).slice(0, MAX_CONTEXT_FIELDS);
}

function buildQueryTerms(message, context) {
  const raw = [
    message,
    context?.query,
    context?.selectedJenis,
    context?.title,
    context?.currentItem?.nama,
    context?.currentItem?.nama_latin,
    context?.currentItem?.jenis,
  ]
    .filter(Boolean)
    .join(" ");

  return Array.from(
    new Set(
      normalizeText(raw)
        .split(" ")
        .filter((word) => word.length >= 3)
    )
  );
}

function hasWholeWord(text, phrase) {
  if (!text || !phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(text);
}

function scoreKnowledgeItem(item, queryTerms, context) {
  const currentName = normalizeText(context?.currentItem?.nama || "");
  const currentLatin = normalizeText(context?.currentItem?.nama_latin || "");
  const selectedJenis = normalizeText(context?.selectedJenis || "");
  const itemName = normalizeText(item.nama);
  const itemLatin = normalizeText(item.nama_latin);
  const itemJenis = normalizeText(item.jenis);

  let score = 0;

  queryTerms.forEach((term) => {
    if (item.searchText.includes(term)) score += 3;
    if (itemName === term || itemLatin === term) score += 8;
    if (itemName.includes(term) || itemLatin.includes(term)) score += 4;
    if (itemJenis && itemJenis === term) score += 5;
  });

  if (currentName && itemName === currentName) score += 10;
  if (currentLatin && itemLatin && itemLatin === currentLatin) score += 8;
  if (selectedJenis && itemJenis && itemJenis === selectedJenis) score += 4;

  return score;
}

function detectKnowledgeMatch(items, message, context, queryTerms) {
  const normalizedMessage = normalizeText(message);
  const currentName = normalizeText(context?.currentItem?.nama || "");
  const currentLatin = normalizeText(context?.currentItem?.nama_latin || "");

  for (const item of items) {
    const nama = normalizeText(item.nama);
    const latin = normalizeText(item.nama_latin);

    if (
      (nama && hasWholeWord(normalizedMessage, nama)) ||
      (latin && hasWholeWord(normalizedMessage, latin))
    ) {
      return {
        item,
        matchType: "exact-name",
        matchReason:
          "Nama tanaman yang ditanyakan user cocok langsung dengan item pada dataset.",
      };
    }
  }

  if (currentName || currentLatin) {
    for (const item of items) {
      const nama = normalizeText(item.nama);
      const latin = normalizeText(item.nama_latin);

      if (
        (currentName && nama === currentName) ||
        (currentLatin && latin && latin === currentLatin)
      ) {
        return {
          item,
          matchType: "page-focus",
          matchReason:
            "Item pada dataset cocok dengan tanaman yang sedang aktif pada halaman.",
        };
      }
    }
  }

  const scored = items
    .map((item) => ({
      item,
      score: scoreKnowledgeItem(item, queryTerms, context),
    }))
    .sort((a, b) => b.score - a.score || a.item.nama.localeCompare(b.item.nama));

  const best = scored[0];
  if (best && best.score > 0) {
    return {
      item: best.item,
      matchType: "semantic-top",
      matchReason:
        "Item ini memiliki kecocokan istilah tertinggi terhadap pertanyaan user dan konteks halaman.",
    };
  }

  return {
    item: null,
    matchType: "none",
    matchReason:
      "Tidak ada item dataset yang benar-benar cocok dengan pertanyaan user.",
  };
}

function getAvailableFields(item) {
  return Object.keys(item?.fields || {}).slice(0, MAX_CONTEXT_FIELDS);
}

function summarizeKnowledgeItem(item) {
  return {
    id: item.id,
    nama: item.nama,
    nama_latin: item.nama_latin,
    jenis: item.jenis,
    manfaat: Array.isArray(item.manfaat) ? item.manfaat.slice(0, 4) : [],
    catatan: Array.isArray(item.catatan) ? item.catatan.slice(0, 3) : [],
    deskripsi: sanitizeContent(item.deskripsi),
    fields: sanitizeFieldMap(item.fields),
  };
}

function pickKnowledgeItems(items, message, context) {
  const queryTerms = buildQueryTerms(message, context);

  return items
    .map((item) => ({
      item,
      score: scoreKnowledgeItem(item, queryTerms, context),
    }))
    .sort((a, b) => b.score - a.score || a.item.nama.localeCompare(b.item.nama))
    .slice(0, MAX_KNOWLEDGE_ITEMS)
    .map(({ item }) => summarizeKnowledgeItem(item));
}

async function buildKnowledgeBase(
  message,
  context,
  dataSource,
  timeoutMs = DATA_SOURCE_TIMEOUT_MS
) {
  const dataset = await loadKnowledgeDataset(dataSource, timeoutMs);
  const queryTerms = buildQueryTerms(message, context);
  const pickedItems = pickKnowledgeItems(dataset, message, context);
  const pickedSummaryItems = pickedItems.map((item) => ({
    ...item,
    searchText: undefined,
  }));
  const detectedMatch = detectKnowledgeMatch(dataset, message, context, queryTerms);
  const matchedItemSummary = detectedMatch.item
    ? summarizeKnowledgeItem(detectedMatch.item)
    : null;

  return sanitizeKnowledgeBase({
    source: dataSource.url,
    note: "Knowledge base ini diambil backend langsung dari API sumber data situs. Jawaban harus berdasarkan data ini. Jika informasi tidak ada di sini, katakan tidak ditemukan pada dataset situs.",
    matchType: detectedMatch.matchType,
    matchReason: detectedMatch.matchReason,
    totalItems: dataset.length,
    availableFields: getAvailableFields(detectedMatch.item || pickedItems[0]),
    queryTerms,
    columns: buildKnowledgeColumns(dataset),
    jenisSummary: buildJenisSummary(dataset),
    items: pickedSummaryItems,
    matchedItem: matchedItemSummary,
  });
}

function buildSystemPrompt(context) {
  const basePrompt =
    "Kamu adalah asisten AI untuk website TOGA. Jawab dalam Bahasa Indonesia, ringkas, jelas, aman, dan membantu. Jika pertanyaan berkaitan dengan kesehatan, jangan memberi diagnosis pasti, jangan menggantikan tenaga kesehatan, dan sarankan pemeriksaan medis saat gejala berat, mendadak, berkepanjangan, atau berbahaya.";
  const knowledgePrompt =
    "Jika knowledgeBase tersedia, gunakan knowledgeBase sebagai sumber fakta utama. Jangan mengarang. Jangan menambah data di luar dataset situs. Knowledge base lebih prioritas daripada konteks halaman umum atau data dummy. Kecocokan `matchedItem`, `matchType`, `availableFields`, dan `knowledgeBase.items` harus dipakai untuk menyusun jawaban. Jika `matchedItem` ada, jawab berdasarkan item itu dan jangan bilang data tidak ditemukan. Jika data kurang lengkap, katakan bahwa dataset hanya memuat field yang tersedia. Hanya bila `matchType` adalah `none` dan kandidat knowledgeBase memang tidak relevan, barulah katakan data tidak ditemukan pada dataset situs.";

  if (!context) return basePrompt;
  if (!context.page && context.knowledgeBase?.items?.length) {
    return `${basePrompt} ${knowledgePrompt}`;
  }

  if (!context.page) return basePrompt;

  if (context.page === "ramuan") {
    return `${basePrompt} Fokus pada ramuan TOGA, tanaman yang relevan, langkah sederhana, cara penggunaan dasar, dan peringatan umum. Jika bahan atau tanaman tidak ada di konteks, katakan dengan jujur. Jangan membuat klaim medis pasti. ${knowledgePrompt}`;
  }

  if (context.page === "tanaman") {
    return `${basePrompt} Fokus pada tanaman TOGA yang sedang dibuka atau terlihat di daftar. Gunakan konteks tanaman aktif bila tersedia, jelaskan manfaat, penggunaan dasar, catatan kehati-hatian, dan kolom data lain yang memang tersedia. ${knowledgePrompt}`;
  }

  if (context.page === "gallery") {
    return `${basePrompt} Fokus pada galeri kegiatan TOGA. Jawab dengan merangkum kegiatan, menjelaskan manfaat kegiatan untuk warga, atau menjelaskan isi dokumentasi yang sedang dibuka. ${knowledgePrompt}`;
  }

  return `${basePrompt} ${knowledgePrompt}`;
}

function findExactKnowledgeMatch(message, context) {
  const items = Array.isArray(context?.knowledgeBase?.items)
    ? context.knowledgeBase.items
    : [];
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) return null;

  return (
    items.find((item) => {
      const nama = normalizeText(item?.nama || "");
      const latin = normalizeText(item?.nama_latin || "");

      return (
        (nama && normalizedMessage.includes(nama)) ||
        (latin && normalizedMessage.includes(latin))
      );
    }) || null
  );
}

function buildKnowledgeInstructionMessage(message, context) {
  const knowledgeBase = context?.knowledgeBase || null;
  const items = Array.isArray(knowledgeBase?.items) ? knowledgeBase.items : [];
  const matchedItem = knowledgeBase?.matchedItem || null;
  const matchType = sanitizeContent(knowledgeBase?.matchType || "");
  const matchReason = sanitizeContent(knowledgeBase?.matchReason || "");
  const availableFields = Array.isArray(knowledgeBase?.availableFields)
    ? knowledgeBase.availableFields
    : [];

  if (items.length === 0) return null;

  const exactMatch = matchedItem || findExactKnowledgeMatch(message, context);

  if (exactMatch) {
    return {
      role: "system",
      content: `Untuk pertanyaan user ini, item yang ditanyakan SUDAH DITEMUKAN di knowledgeBase situs. Prioritaskan item ini dibanding konteks halaman lain. Jangan jawab bahwa item tersebut tidak ditemukan. matchType=${matchType || "exact"}; alasan=${matchReason || "item cocok dengan pertanyaan user"}; field tersedia=${JSON.stringify(
        availableFields
      )}. Gunakan data item berikut sebagai rujukan utama:\n${JSON.stringify(
        exactMatch
      )}`,
    };
  }

  return {
    role: "system",
    content: `Gunakan item-item knowledgeBase berikut sebagai kandidat utama jawaban. matchType=${matchType || "unknown"}; alasan=${matchReason || "-"}; field utama yang tersedia=${JSON.stringify(
      availableFields
    )}. Knowledge base lebih prioritas daripada konteks halaman. Jika salah satu item relevan, jelaskan berdasarkan field item itu dan jangan bilang data tidak ditemukan:\n${JSON.stringify(
      items
    )}`,
  };
}

function buildKnowledgeContextMessage(context) {
  if (!context?.knowledgeBase) return null;

  return {
    role: "system",
    content: `Knowledge base utama untuk pertanyaan ini:\n${JSON.stringify(
      context.knowledgeBase
    )}`,
  };
}

function buildPageContextMessage(context) {
  if (!context || typeof context !== "object") return null;

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

  const hasMeaningfulPageContext = Object.values(compact).some((value) =>
    Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined && value !== ""
  );

  if (!hasMeaningfulPageContext) return null;

  return {
    role: "system",
    content: `Konteks halaman berikut hanya pelengkap UI dan bersifat sekunder. Gunakan hanya jika konsisten dengan knowledgeBase:\n${JSON.stringify(
      compact
    )}`,
  };
}

function buildMessages(message, history, context) {
  const knowledgeInstructionMessage = buildKnowledgeInstructionMessage(
    message,
    context
  );
  const knowledgeContextMessage = buildKnowledgeContextMessage(context);
  const pageContextMessage = buildPageContextMessage(context);

  return [
    {
      role: "system",
      content: buildSystemPrompt(context),
    },
    ...(knowledgeInstructionMessage ? [knowledgeInstructionMessage] : []),
    ...(knowledgeContextMessage ? [knowledgeContextMessage] : []),
    ...(pageContextMessage ? [pageContextMessage] : []),
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

function getOpenRouterModelCandidates() {
  return Array.from(new Set([DEFAULT_MODEL, ...FALLBACK_MODELS])).filter(Boolean);
}

function extractOpenRouterErrorMessage(data, status, model) {
  const detail =
    data?.error?.message ||
    data?.message ||
    `OpenRouter request failed with HTTP ${status}`;

  return model ? `[${model}] ${detail}` : detail;
}

function shouldRetryOpenRouterError(error) {
  return OPENROUTER_RETRYABLE_STATUSES.has(Number(error?.status));
}

function buildTransientProviderMessage(lastError, attemptedModels) {
  const modelsText = attemptedModels.filter(Boolean).join(", ");
  const suffix = modelsText
    ? ` Model yang dicoba: ${modelsText}.`
    : "";

  return (
    "Provider AI sementara tidak tersedia atau sedang sibuk. Coba lagi beberapa saat lagi, atau ganti model OpenRouter di environment backend." +
    suffix +
    (lastError?.message ? ` Detail terakhir: ${lastError.message}` : "")
  );
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

async function sendOpenRouterRequest(
  messages,
  origin,
  model,
  timeoutMs = OPENROUTER_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders(origin),
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    }),
  }).finally(() => {
    clearTimeout(timer);
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw createHttpError(
      extractOpenRouterErrorMessage(data, response.status, model),
      response.status
    );
  }

  return {
    reply: extractReplyText(data),
    raw: data,
    model,
  };
}

async function sendOpenRouterChat(
  messages,
  origin,
  timeoutMs = OPENROUTER_TIMEOUT_MS
) {
  const startedAtMs = Date.now();
  const modelCandidates = getOpenRouterModelCandidates();
  const totalAttempts = modelCandidates.length === 1 ? 2 : modelCandidates.length;
  const attemptedModels = [];
  let lastError = null;
  let attemptsUsed = 0;

  for (let index = 0; index < modelCandidates.length; index += 1) {
    const model = modelCandidates[index];
    const maxAttempts = modelCandidates.length === 1 ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed += 1;
      attemptedModels.push(attempt > 1 ? `${model} (retry)` : model);

      const attemptsLeft = Math.max(totalAttempts - attemptsUsed + 1, 1);
      const remainingTimeoutMs = Math.max(
        timeoutMs - (Date.now() - startedAtMs),
        MIN_STAGE_TIMEOUT_MS
      );
      const perAttemptTimeoutMs = Math.max(
        MIN_STAGE_TIMEOUT_MS,
        Math.floor(remainingTimeoutMs / attemptsLeft)
      );

      try {
        return await sendOpenRouterRequest(
          messages,
          origin,
          model,
          perAttemptTimeoutMs
        );
      } catch (error) {
        lastError = error;

        if (!shouldRetryOpenRouterError(error)) {
          throw error;
        }

        const hasNextModel = index < modelCandidates.length - 1;
        const shouldRetrySameModel = modelCandidates.length === 1 && attempt < maxAttempts;

        if (!hasNextModel && !shouldRetrySameModel) {
          throw createHttpError(
            buildTransientProviderMessage(error, attemptedModels),
            Number(error?.status) || 503
          );
        }

        await sleep(OPENROUTER_RETRY_DELAY_MS);
      }
    }
  }

  throw createHttpError(
    buildTransientProviderMessage(lastError, attemptedModels),
    Number(lastError?.status) || 503
  );
}

export default async function handler(req, res) {
  const startedAtMs = Date.now();
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
    const { message, history = [], context = null, dataSource = null } =
      req.body || {};
    const trimmedMessage = sanitizeContent(message);

    if (!trimmedMessage) {
      return res.status(400).json({
        error: "Field 'message' wajib berupa string dan tidak boleh kosong.",
      });
    }

    const safeHistory = sanitizeHistory(history);
    const safeContext = sanitizeContext(context);
    const safeDataSource = sanitizeDataSource(dataSource);
    const dataSourceTimeoutMs = clampStageTimeout(
      DATA_SOURCE_TIMEOUT_MS,
      getRemainingBudgetMs(startedAtMs)
    );
    const finalContext =
      safeDataSource && safeContext
        ? {
            ...safeContext,
            knowledgeBase: await buildKnowledgeBase(
              trimmedMessage,
              safeContext,
              safeDataSource,
              dataSourceTimeoutMs
            ),
          }
        : safeDataSource
        ? {
            knowledgeBase: await buildKnowledgeBase(
              trimmedMessage,
              null,
              safeDataSource,
              dataSourceTimeoutMs
            ),
          }
        : safeContext;

    const messages = buildMessages(trimmedMessage, safeHistory, finalContext);
    const openRouterTimeoutMs = clampStageTimeout(
      OPENROUTER_TIMEOUT_MS,
      getRemainingBudgetMs(startedAtMs)
    );
    const result = await sendOpenRouterChat(messages, origin, openRouterTimeoutMs);

    return res.status(200).json({
      reply: result.reply || "",
      model: result.model || DEFAULT_MODEL,
      provider: "openrouter",
      knowledgeSource: safeDataSource?.url || "",
    });
  } catch (error) {
    console.error("OpenRouter error:", error);

    const isAbortError =
      error?.name === "AbortError" ||
      /aborted|timeout/i.test(String(error?.message || ""));

    const status = error?.status || (isAbortError ? 504 : 500);

    return res.status(status).json({
      error: isAbortError
        ? "Backend kehabisan waktu saat menunggu respons."
        : status === 503
        ? "Provider AI sementara tidak tersedia."
        : "Terjadi kesalahan di server.",
      detail: isAbortError
        ? `Permintaan tidak selesai sebelum batas waktu proses Vercel habis (maks. ${FUNCTION_BUDGET_MS} ms).`
        : error?.message || "Unknown error",
      provider: "openrouter",
      status,
    });
  }
}
