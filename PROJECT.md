# cods — the project, and every Cloudflare piece in it

`cods` (cards) is a single Cloudflare Worker that decides, researches, answers and
speaks, with its whole front end inline. It is deployed at
`https://cods.ai-n.workers.dev`; pushing `main` deploys it. One entry point
([worker.js](worker.js)), no build step, no framework, no bundler — the Worker
serves its own HTML, CSS and client script out of the same file that answers the
API.

This document is the map: what the project is, which Cloudflare products it leans
on, and the snippet it uses for each. Code below is copied from the source, not
paraphrased, so it can be searched for and found.

---

## 1. What it does

One request in, one card out:

| step | what happens | where |
| --- | --- | --- |
| cache | has this been answered before? answer cache first, then R2 long-term memory | `cacheGet`, `ltmGet` |
| decide | `clef-flash` → `clef-omni` → `clef` classify intent, domain, need-for-web, care, depth, tone | `decide()` |
| search | only when the decision asks for it: OpenRouter's web plugin, then a real page through Browser Run, then plain HTTP engines | `webSearch()` |
| answer | Workers AI chat (DeepSeek V4 Flash, then granite) or OpenRouter, grounded in the sources | `askText()` |
| keep | answer cached in KV, written to R2 for good, logged to ARCHIVE, mirrored into AI Search | `ltmPut`, `archiveLog`, `indexCard` |

Beside that it exposes `/speak` (text → audio), `/stt` (audio → text, free and
ungated), `/prefs` (his rules, preferences, domains, length dial), `/principles`,
`/truths` (curated truth store), `/health`, `/mcp` (tool surface), `/thread`
(what the whole conversation is working on), and `/chat` (the answer path,
optionally streaming NDJSON).

---

## 2. The deployment shape

One Worker, one file, and these bindings. `wrangler.jsonc` is the source of truth:

| binding | type | product | used for |
| --- | --- | --- | --- |
| `AI` | `ai` | Workers AI | clef decisions, DeepSeek/granite chat, aura-2 / melotts voices, whisper STT |
| `BROWSER` | `browser` (`remote: true`) | Browser Run | `quickAction("scrape")` on DuckDuckGo / Bing |
| `mainspace` | `ai_search_namespaces` | AI Search | writing cards into the `ai-inspired` namespace, instance `NSM` |
| `CONTEXT` | KV | Workers KV | what the app knows about this person: rules, decks, theme, length dial |
| `ARCHIVE` | KV | Workers KV | signed-off answers and the ask log |
| `CACHE` | KV | Workers KV | the short-lived answer cache only |
| `KV` | KV | Workers KV | fallback store, and everything written before the split |
| `TRUTHS` / `AUDITS` | KV | Workers KV | the truth store and its audit trail |
| `LTM` | R2 | R2 | every answer, kept for good (`long-term-memory`) |
| `LOADER` | `worker_loaders` | Workers for Platforms | loading user code (declared, optional) |
| `ORPROXY` | service (`unsafe`) | Workers service binding | OpenRouter proxy: the key and the model stay in that Worker |

Two config facts the code depends on:

```jsonc
"compatibility_date": "2026-03-24",        // quickAction() and the clef APIs need it
"compatibility_flags": ["nodejs_compat"],  // @cloudflare/puppeteer reaches for node:buffer
```

The AI Search namespace, as bound:

```jsonc
"ai_search_namespaces": [
    {
      "binding": "mainspace",
      "namespace": "ai-inspired",
      "remote": true
    }
  ],
```

Every binding is optional at runtime: each call site checks for it and moves down
the chain, so removing one degrades a feature instead of failing a request.

---

## 3. Cloudflare snippets

### 3.1 Module entry, CORS and the health surface

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cH });
    }

    if (url.pathname === "/health") {
      return json({
        status: "ok",
        clef: !!env.AI,
        browser: !!env.BROWSER,
        orproxy: !!env.ORPROXY,
        memory: { context: !!env.CONTEXT, archive: !!env.ARCHIVE, cache: !!env.CACHE, kv: !!env.KV, ltm: !!env.LTM, shapes: !!env.LTM, loader: !!env.LOADER },
        stt: !!env.AI,
        stream: "ndjson",
      });
    }
```

`ctx` is accepted but not used: nothing here has background work that outlives the
response. Every write is awaited before the reply, which is why there is no
`ctx.waitUntil` anywhere in the file. If a future write should not hold the
response open, that is where it goes — `ctx.waitUntil(...)`, called as a method,
never destructured (`const { waitUntil } = ctx` loses the receiver).

### 3.2 Workers AI chat (`env.AI.run`)

```js
if (env.AI) {
  for (const cfModel of cfModels) {
    try {
      const text = textFrom(await env.AI.run(cfModel, Object.assign({ messages: forCf }, settings)));
      if (text) return { text, provider: "clef-flash → " + cfModel, trace: [{ source: "workers-ai", model: cfModel }] };
      failures.push(cfModel + ": empty response");
    } catch (err) {
      failures.push(cfModel + ": " + err.message);
    }
  }
}
```

Chat models, in order: `@cf/deepseek-ai/deepseek-v4-flash-0731` (1,048,576
window), then `@cf/ibm-granite/granite-4.0-h-micro`. No Llama anywhere.

The same call shape compresses an oversized state before a decision:

```js
const out = textFrom(
  await env.AI.run(entry.model, {
    messages: [
      { role: "system", content: compressInstructions(budget) },
      { role: "user", content: raw },
    ],
    max_tokens: 2000,
    temperature: 0.2,
  })
);
```

### 3.3 Decisions API — the clef ladder

```js
const DECISION_LADDER = [
  { id: "@cf/cloudflare/clef-flash", model: "clef-flash", context: 24576 },
  { id: "@cf/cloudflare/clef-omni",  model: "clef-omni",  context: 64000 },
  { id: "@cf/cloudflare/clef",       model: "clef",       context: 65536 },
];
```

```js
let candidates = order.filter((m) => tokens <= m.context - DECISION_RESERVE);
const fits = candidates.length > 0;
if (!fits) candidates = [order[order.length - 1]];

for (const entry of candidates) {
  try {
    const res = await env.AI.run(entry.id, { model: entry.model, state, questions: asked });
    answered = res;
    usedBy = entry.id;
    break;
  } catch (err) {
    lastError = err;
    // Only a window refusal is worth moving up the ladder for.
    if (!/context window|5021|too large|exceeded/i.test(String(err && err.message))) throw err;
  }
}
```

Two platform rules, both encoded above:

- `model` must be the **short name** (`clef-omni`); the API validates it against
  `^\s*clef(-omni|-flash)?\s*$` and rejects the `@cf/...` id, which is the
  binding-side name only.
- The platform does **not** trim state for you. Past the window it answers HTTP
  413 with code **5021**, so the state is budgeted here (~3 chars per token) and
  the question is placed first: whatever is dropped, clef still sees the ask.

### 3.4 Text to speech — `/speak`

```js
  async function speakOnWorkersAi(env, model, text, voice) {
    if (!env.AI || typeof env.AI.run !== "function") return { error: "The AI binding is not on this Worker", status: 503 };
    const tries = model === "@cf/myshell-ai/melotts"
      ? [{ prompt: text, lang: voice || "en" }]
      : [{ text, speaker: voice || "thalia" }, { text, speaker: voice || "thalia", encoding: "mp3" }];
    let last = "no audio";
    for (const input of tries) {
      try {
        const got = await audioFromWorkersAi(await env.AI.run(model, input));
        if (got && got.bytes.length) return got;
        last = "the model returned no audio";
      } catch (err) {
        last = String((err && err.message) || err).slice(0, 300);
      }
    }
    return { error: "The Workers AI voice did not answer", detail: last, status: 502 };
  }
```

Input shapes differ per model — `{ prompt, lang }` for melotts, `{ text, speaker }`
for aura — and that difference is the whole reason for the two-attempt loop. The
return shape differs too, so one normaliser takes whatever comes back:

```js
  async function audioFromWorkersAi(out) {
    if (!out) return null;
    if (out instanceof Response) {
      return { bytes: new Uint8Array(await out.arrayBuffer()), type: out.headers.get("content-type") || "audio/mpeg" };
    }
    if (out instanceof ArrayBuffer) return { bytes: new Uint8Array(out), type: "audio/mpeg" };
    if (ArrayBuffer.isView(out)) return { bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), type: "audio/mpeg" };
    if (typeof out.getReader === "function") return { bytes: await collectStream(out), type: "audio/mpeg" };
    if (typeof out.audio === "string") return { bytes: decodeAudioBase64(out.audio), type: "audio/mpeg" };
    if (out.audio instanceof ArrayBuffer) return { bytes: new Uint8Array(out.audio), type: "audio/mpeg" };
    if (out.audio && typeof out.audio.getReader === "function") return { bytes: await collectStream(out.audio), type: "audio/mpeg" };
    return null;
  }
```

Voices offered on the sheet: `@cf/deepgram/aura-2-en` (thalia, apollo, athena,
orion…), `@cf/deepgram/aura-1`, `@cf/myshell-ai/melotts` (cheapest). The reply
carries `Content-Type: audio/mpeg`, `Cache-Control: no-store` and
`X-Voice-Model: <model>`, so the browser can tell which voice spoke.

### 3.5 Speech to text — `/stt`, free and ungated

```js
  if (url.pathname === "/stt") {
    if (request.method !== "POST") {
      return json({ error: "Use POST with the audio as the body" }, 405);
    }
```

The model wants base64, so the clip is encoded in 32 KiB slices — one
`String.fromCharCode.apply` on a multi-megabyte array blows the argument limit:

```js
function sttShapes(clip) {
  const bytes = new Uint8Array(clip);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return [{ audio: btoa(bin) }];
}

async function transcribe(env, clip, format) {
  const shapes = sttShapes(clip);
  let last = null;
  for (const model of STT_MODELS) {          // ["@cf/openai/whisper-large-v3-turbo"]
    for (const input of shapes) {
      try {
        const text = sttText(await env.AI.run(model, input));
        if (text) return { text, model };
        last = model + ": empty response";
      } catch (err) {
        last = model + ": " + String((err && err.message) || err);
      }
    }
  }
  return { text: "", model: null, error: last };
}
```

Nobody is turned away for who they are. The only limit is a per-address daily
clip count in KV with a TTL — a ceiling, not a paywall:

```js
async function sttBudget(env, request) {
  const store = cacheStore(env);
  if (!store || !store.put) return null;
  const ip = String(request.headers.get("cf-connecting-ip") || "unknown");
  const key = "stt:" + new Date().toISOString().slice(0, 10) + ":" + ip;
  let used = 0;
  try {
    used = Number(await store.get(key)) || 0;
  } catch (err) {
    return null;
  }
  if (used >= STT_DAILY_CLIPS) {
    return "That is " + STT_DAILY_CLIPS + " clips from this connection today. Try again tomorrow.";
  }
  try {
    await store.put(key, String(used + 1), { expirationTtl: 90000 });
  } catch (err) {}
  return null;
}
```

### 3.6 KV — four namespaces, one helper set

Memory is split by how long each piece is meant to last, and every read falls back
so nothing written before the split is lost:

```js
function ctxStore(env)   { return env.CONTEXT || env.KV || null; }
function arcStore(env)   { return env.ARCHIVE || env.KV || null; }
function cacheStore(env) { return env.CACHE   || env.KV || null; }
function truthStore(env) { return env.TRUTHS  || env.ARCHIVE || env.KV || null; }

async function readMoved(env, store, key) {
  try {
    const raw = await store.get(key);
    if (raw || !env.KV || env.KV === store) return raw;
    return await env.KV.get(key);
  } catch (err) {
    return null;
  }
}
```

Writing a rule is a whole-record read, edit, write — no partial updates, so
nothing else in the record can be lost:

```js
prefs = raw ? JSON.parse(raw) || {} : {};
prefs.domainRules[dom] = Array.isArray(prefs.domainRules[dom]) ? prefs.domainRules[dom] : [];
prefs.domainRules[dom].push({ text, at: new Date().toISOString() });
await store.put(PREFS_KEY, JSON.stringify(prefs));   // PREFS_KEY = "prefs:v1"
```

### 3.7 R2 — every answer, kept for good

```js
async function ltmPut(env, prompt, payload) {
  if (!env.LTM) return "no bucket";
  const body = JSON.stringify({
    prompt,
    answer: payload.answer,
    cards: payload.cards,
    provider: payload.provider,
    route: payload.route,
    decision: payload.decision,
    at: new Date().toISOString(),
  });
  await env.LTM.put(await ltmKey(prompt), body, { httpMetadata: { contentType: "application/json" } });
  return "kept";
}

async function ltmGet(env, prompt) {
  if (!env.LTM) return null;
  try {
    const obj = await env.LTM.get(await ltmKey(prompt));
    if (!obj) return null;
    const parsed = JSON.parse(await obj.text());
    return parsed && parsed.answer ? parsed : null;
  } catch (err) {
    return null;
  }
}
```

Keys are hashed, not the question, so a long prompt cannot make a long key.
Images go in the same bucket under a size guard, and shared cards are served from
it as HTML:

```js
    await env.LTM.put("share/" + id + ".html", page, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
```

### 3.8 Browser Run — a real page through `quickAction`

```js
async function browserPage(env, engine, q) {
  if (!env.BROWSER) throw new Error("no BROWSER binding");
  if (typeof env.BROWSER.quickAction !== "function") {
    throw new Error("BROWSER binding has no quickAction(); the compatibility date is older than 2026-03-24");
  }
  const res = await env.BROWSER.quickAction("scrape", {
    url: engine.url(q),
    elements: [{ selector: engine.link }, { selector: engine.snippet }, { selector: "title, h1" }],
    userAgent: BROWSER_UA,
    gotoOptions: { waitUntil: engine.waitUntil || "domcontentloaded" },
  });
  const status = res && typeof res.status === "number" ? res.status : 0;
  if (status >= 400) throw new Error(engine.name + " answered http " + status);
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    throw new Error(engine.name + " returned no scrape payload");
  }
```

Four engines are tried in order (`ddg-lite`, `ddg`, `ddg-html`, `bing`), each with
its own selectors and wait condition — `networkidle2` for the app page that paints
its results after load, `domcontentloaded` elsewhere. A real desktop `User-Agent`
is sent because Browser Run's default headless UA gets a results-free document
from DuckDuckGo. Results are scored against the query's own terms before they can
become a card: a search page's did-you-mean answer is a failure here, not a
source.

Local development needs `"remote": true` on the browser binding, or `wrangler dev`
answers *"The RPC receiver does not implement the method quickAction"*.

### 3.9 AI Search — cards become notes

```js
function indexHandle(env) {
  const binding = env.mainspace || env.AI_SEARCH;
  if (!binding) return null;
  if (binding.items && typeof binding.items.upload === "function") return binding;
  if (typeof binding.get === "function") {
    return binding.get(env.AI_SEARCH_INSTANCE || AI_SEARCH_INSTANCE);
  }
  return null;
}
```

```js
const handle = indexHandle(env);
if (handle) {
  const item = await handle.items.upload(name, doc);   // name: cards/<hash>.md
  return "indexed " + (item && item.key ? item.key : name);
}
```

Two things worth keeping: namespace names must be lowercase (the API rejects
capitals with code **7001**), and the index is a search surface, not a store — it
cannot be read back by id, so each card is also mirrored into R2. When the binding
is absent the same write falls back to the REST endpoint with a token, and if
neither exists the call reports *"no index writer"* rather than dropping the card.

### 3.10 Service binding — the OpenRouter proxy

```js
  const settings = { messages, model: preset, stream: false };
  if (body.max_tokens != null) settings.max_tokens = body.max_tokens;
  if (body.temperature != null) settings.temperature = body.temperature;
```

```js
      const res = await binder.fetch("https://orproxy" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
```

The service binding is declared under `unsafe.bindings`: a `services` entry is
checked against the account at deploy time, and a binding to a Worker that is not
there fails the whole deploy, so the shape already known to work is the one kept.
The proxy prefixes the model with `@preset/`, so it is sent a preset name, and
`stream: false` so the reply is one envelope. `max_tokens` is only sent when the
caller named one: a default can exceed what the preset's model accepts and fail
the whole call.

### 3.11 Streaming the steps — NDJSON over `TransformStream`

```js
if (body.stream === true && !emit) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (ev) => { writer.write(encoder.encode(JSON.stringify(ev) + "\n")).catch(() => {}); };
  const inner = Object.assign({}, body);
  delete inner.stream;
  const innerReq = new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(inner),
  });
  (async () => {
    try {
        const res = await handleChat(innerReq, env, send);
        const payload = await res.json();
        send({ type: "done", status: res.status, payload });
    } catch (err) {
      send({ type: "error", error: String((err && err.message) || err) });
    } finally {
      try { await writer.close(); } catch (err) {}
    }
  })();
  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
```

NDJSON rather than SSE: one JSON object per line, one line per step, then a
`{type:"done"}` carrying the usual payload. Each write is `.catch()`-guarded, so a
client that walks away mid-answer cannot throw out of the streaming task.

### 3.12 Response helpers used everywhere

```js
const cH = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cH },
  });
}
```

Cache headers are explicit on every path: an answer is either `no-store`, or held
by `Cache-Control` plus the KV cache key. Nothing relies on a default.

---

## 4. Gotchas already paid for

| symptom | cause | what the code does now |
| --- | --- | --- |
| 413 with code `5021`, decision lost | state larger than clef's 24,576-token window; the platform does not trim | budget the state, put the question first, move up the ladder only on a window refusal |
| `model: "@cf/cloudflare/clef-omni"` rejected | Decisions API wants the short name | short name in `model`, `@cf` id only for `env.AI.run` |
| `quickAction is not a function` | `compatibility_date` older than `2026-03-24` | the date is pinned in `wrangler.jsonc` |
| `RPC receiver does not implement the method quickAction` under `wrangler dev` | local Browser Run has no renderer | `"remote": true` on the browser binding |
| namespace rejected with code `7001` | capitals in the AI Search namespace name | `ai-inspired` |
| `node:buffer` at import time | `@cloudflare/puppeteer` | `compatibility_flags: ["nodejs_compat"]` |
| audio "returned no audio" for aura | aura wants `{text, speaker}`, melotts wants `{prompt, lang}` | both shapes tried, then both encodings |
| a deploy fails on a KV namespace | `TRUTHS` / `AUDITS` not on the account | comment the two entries out; `truthStore()` falls back to ARCHIVE |

---

## 5. Running it

```sh
npm run check     # node --check worker.js
npm test          # node test.mjs  — 662 checks
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy  (pushing main already does this)
```

`test.mjs` drives the real `fetch` handler with a fake `env` (in-memory KV, fake
R2, a stubbed `AI.run`) and reads the served HTML back out of the response, so
routing, storage, the decisions ladder and the page's own script are covered
without a browser.

Off limits, permanently: the front end at `ai-nspired.com`, `i.nspired.cc`,
`orproxy`, and every other Worker on the account. This repository deploys `cods`
only.
