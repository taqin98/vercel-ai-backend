# Vercel AI Backend

Backend serverless ini dipakai untuk memanggil OpenAI dari sisi server agar API key tidak pernah muncul di browser.

## Struktur

```txt
vercel-ai-backend/
├── api/
│   └── chat.js
├── package.json
├── vercel.json
└── .env.example
```

## Environment Variables

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
  Default: `gpt-5-mini`
- `ALLOWED_ORIGINS`
  Pisahkan dengan koma, contoh:
  `https://taqinjunior56.github.io,https://taqinjunior56.github.io/ai-web`

## Local Check

```bash
cd vercel-ai-backend
npm install
npm run check
```

## Deploy ke Vercel

1. Buat repo baru untuk folder ini atau push sebagai folder terpisah.
2. Import repo ke Vercel.
3. Tambahkan environment variables dari `.env.example`.
4. Deploy.

## Endpoint

`POST /api/chat`

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
  "model": "gpt-5-mini"
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
