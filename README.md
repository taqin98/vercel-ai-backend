# Vercel AI Backend

Backend serverless ini dipakai untuk memanggil OpenRouter dari sisi server agar API key tidak pernah muncul di browser.

## Struktur

```txt
vercel-ai-backend/
├── api/
│   ├── chat.js
│   └── image-proxy.js
├── package.json
├── vercel.json
└── .env.example
```

## Environment Variables

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
  Default: `openrouter/free`
- `OPENROUTER_FALLBACK_MODELS`
  Opsional. Daftar model cadangan dipisahkan koma. Dipakai saat model utama kena `429/5xx` dari provider.
- `FUNCTION_TIMEOUT_MS`
  Opsional. Timeout fungsi dalam milidetik. Default backend ini diasumsikan `10000` ms agar masih ada headroom sebelum Vercel memotong request.
- `OPENROUTER_SITE_URL`
  Disarankan isi URL situs GitHub Pages Anda untuk header `HTTP-Referer`.
- `OPENROUTER_APP_NAME`
  Default lokal: `TOGA RT 09`
- `ALLOWED_ORIGINS`
  Pisahkan dengan koma, contoh:
  `https://taqinjunior56.github.io,https://taqinjunior56.github.io/ai-web,http://localhost:4173,http://127.0.0.1:4173`

Catatan:
- Backend ini juga otomatis mengizinkan origin lokal umum seperti `http://localhost:4173`, `http://localhost:5173`, `http://127.0.0.1:4173`, dan `http://127.0.0.1:5173`.
- Untuk preview lokal, tetap aman jika `ALLOWED_ORIGINS` Anda juga memuat origin yang benar-benar dipakai browser.

## Local Check

```bash
cd vercel-ai-backend
npm install
npm run check
```

## Deploy ke Vercel

1. Buat repo baru untuk folder ini atau push sebagai folder terpisah.
2. Import repo ke Vercel.
3. Tambahkan environment variables baru:
   - `OPENROUTER_API_KEY`
   - `OPENROUTER_MODEL`
   - `OPENROUTER_FALLBACK_MODELS`
   - `FUNCTION_TIMEOUT_MS`
   - `OPENROUTER_SITE_URL`
   - `OPENROUTER_APP_NAME`
   - `ALLOWED_ORIGINS`
4. Deploy atau redeploy setelah env diubah.

## Endpoint

`POST /api/chat`

`GET /api/image-proxy?url=<encoded-image-url>`

Catatan `image-proxy`:
- Dipakai untuk me-render thumbnail Google Drive sebagai texture A-Frame / WebGL tanpa mentok CORS browser.
- Host upstream dibatasi ke domain Google Drive / Googleusercontent yang relevan.
- Frontend bisa mengarah ke endpoint ini lewat `window.TOGA_CONFIG.imageProxyUrl`.

Body:

```json
{
  "message": "Halo",
  "history": [
    { "role": "user", "content": "Hai" },
    { "role": "assistant", "content": "Halo, ada yang bisa saya bantu?" }
  ]
}
```

Respons:

```json
{
  "reply": "Halo, ada yang bisa saya bantu?",
  "model": "openrouter/free",
  "provider": "openrouter"
}
```

## Contoh Fetch dari Frontend

```js
const response = await fetch("https://YOUR-VERCEL-APP.vercel.app/api/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    message: "Tanaman apa yang cocok untuk batuk ringan?",
    history: [],
  }),
});

const data = await response.json();
console.log(data.reply);
```

## Catatan Model Gratis

OpenRouter menyediakan model gratis, tetapi daftar dan ketersediaannya bisa berubah. Untuk awal yang sederhana, gunakan `OPENROUTER_MODEL=openrouter/free`, lalu jika Anda ingin model gratis spesifik yang sedang aktif, ganti nilainya di environment Vercel tanpa perlu mengubah frontend.

Jika Anda sering mendapat error provider seperti `503`, isi juga `OPENROUTER_FALLBACK_MODELS` agar backend bisa mencoba model cadangan sebelum gagal total.

Jika log Vercel menunjukkan fungsi berhenti di sekitar 10 detik, set `FUNCTION_TIMEOUT_MS=10000` atau sesuai limit plan/runtime Anda. Backend ini akan menyisakan headroom agar respons error masih sempat dikirim sebelum function diputus.
