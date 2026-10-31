# Model map — Cloudflare Workers AI vs OpenRouter

Two providers, two different call shapes, and they do not overlap as much as they look.

- **Cloudflare** (`env.AI.run(id, inputs)`) — one binding, typed inputs per task, billed per unit.
  Model ids are `@cf/<author>/<slug>`. A wrong id fails loudly on the call, so each one below is
  safe to try before wiring.
- **OpenRouter** (`POST https://openrouter.ai/api/v1/chat/completions`) — one key on `cods`
  (`OPENROUTER_API_KEY`), chat-shaped for text, plus **dedicated endpoints for the other
  modalities**: `POST /api/v1/audio/transcriptions` (speech → text, base64 + format),
  `POST /api/v1/audio/speech` (text → raw audio bytes), `POST /api/v1/images` (image output),
  `POST /api/v1/videos` (async video jobs, poll `/api/v1/videos/{job}`), and an embeddings router
  exposed through its SDK. Images, PDFs, audio and video go **in** through `/api/v1/responses`
  as `input_image` / `input_file` / `input_audio` / `input_video`. Presets are `@preset/<name>`.
Source lists, pulled 31 Oct 2026: `developers.cloudflare.com/workers-ai/models/index.md` (73 models)
and `openrouter.ai/api/v1/models` (456 models).

## Roles

| Role | Cloudflare | OpenRouter | What I'd use, and why |
| - | - | - | - |
| **Router / decision** | `@cf/cloudflare/clef-flash` (current), `clef`, `clef-omni` (audio + video in) | any cheap chat model, but nothing returns per-option probabilities | **clef-flash**. It is a decision model: state plus a schema of typed questions in, a probability for every option out. A chat model needs a JSON contract and still gives one answer, not a distribution — that's the whole reason the card loop works. |
| **Router fallback (big context)** | `@cf/deepseek-ai/deepseek-v4-pro-0813` (1M), `@cf/moonshotai/kimi-k2.6` (262k), `@cf/zai-org/glm-5.3` (1M) | `particle-ai/particle-1` (1.05M), `openai/gpt-6.1-terra` (1.05M), `minimax/minimax-m3.1-flash` (1.05M) | Whatever clef-flash cannot fit goes here and the card says the router changed. |
| **Answer / generation** | `@cf/ibm-granite/granite-4.0-h-micro` (**current default, unchanged**), `llama-3.3-70b-instruct-fp8-fast`, `gpt-oss-120b`, `glm-5.3` | whatever the picker names: `openai/gpt-4o-mini`, `deepseek/deepseek-v3.1`, `google/gemini-flash`, `anthropic/claude-haiku`, `meta-llama/llama-70b`, plus `@preset/truth` | Cloudflare stays the default; OpenRouter answers when chosen. |
| **Summarisation** | `@cf/meta/llama-3.2-3b-instruct` (default), `llama-3.2-1b-instruct` (cheapest) | `z-ai/glm-5.2` ($0.006/M prompt), `openai/gpt-oss-20b`, `inclusionai/ling-3.0-flash` | Cheap and separate from the answerer, so card copy never costs an answer-model call. |
| **Embeddings** | `@cf/baai/bge-m3` (multilingual, best default), `bge-large-en-v1.5` (1024d), `bge-small-en-v1.5` (384d), `qwen3-embedding-0.6b`, `embeddinggemma-300m` (beta), `plamo-embedding-1b` (Japanese) | `POST /api/v1/embeddings` — `{model, input, dimensions?}` (e.g. `openai/text-embedding-3-small`, 1536d, `dimensions` lets you shorten it) | Cloudflare for this one: explicit ids, dimensions and per-token billing, all documented, and it runs next to the truth store. |
| **Reranking** | `@cf/baai/bge-reranker-base` (query + passage → relevance) | `POST /api/v1/rerank` — `{model:"voyageai/rerank-3", query, documents:[...], top_n}` → `results[]` of `{index, relevance_score, document.text}` | Either side. OpenRouter's rerank scores come back with the source text attached, which is handy when the card cites what it ranked. |
| **Tone / feeling** | `@cf/huggingface/distilbert-sst-2-int8` (POSITIVE/NEGATIVE + score), `llama-guard-3-8b` (safety categories) | any cheap chat model prompted for JSON (`z-ai/glm-5.2`, `openai/gpt-oss-20b`) | distilbert on every request as the free-ish signal; a chat model only when the router asks for nuance (frustration, urgency). |
| **Intent / domain** | clef itself (typed questions with probabilities), plus embeddings for nearest-known-intent | cheap chat model with a JSON schema | clef first: it already returns the distribution, so intent is a question in the schema rather than another call. |
| **Image generation** | `@cf/black-forest-labs/flux-1-schnell`, `flux-2-klein-4b`, `flux-2-klein-9b`, `flux-2-dev`, `lucid-origin`, `phoenix-1.0`, `dreamshaper-8-lcm`, `stable-diffusion-xl-base-1.0`, `stable-diffusion-v1-5-inpainting` | `POST /api/v1/images` with `google/gemini-3.1-flash-image`, `google/gemini-3-pro-image`, `google/gemini-nano-banana-2.1`, `openai/gpt-5.4-image-2` | Cloudflare for cheap/fast; OpenRouter's `/images` when quality matters and it is a card worth paying for. |
| **Video generation** | not offered by Workers AI | `POST /api/v1/videos` — submit a prompt (optionally with reference/frame images), get a job id, poll `/api/v1/videos/{job}` until the MP4 is ready; webhooks for completion | OpenRouter only. Nothing in `cods` should block on a video job, so this belongs on a card that says "still rendering". |
| **Image understanding** | `@cf/meta/llama-3.2-11b-vision-instruct`, `llama-4-scout-17b-16e-instruct`, `llava-1.5-7b-hf`, `moondream3.1-9B-A2B` (OCR, pointing), `mistral-small-3.1-24b-instruct` | any vision model via `/api/v1/responses` with `input_image` (URL or base64) | Cloudflare `moondream` for OCR-ish card work, `llama-3.2-11b-vision` for describing. |
| **Speech → text (ASR)** | `@cf/deepgram/nova-3`, `@cf/deepgram/flux` (conversational) | `POST /api/v1/audio/transcriptions` — `{model, input_audio:{data, format}}`, base64 raw bytes, `verbose_json` for word timestamps, OpenAI-compatible multipart too | Cloudflare if the audio is already in R2 and the answer stays in the Worker; OpenRouter's route when you want one key and Whisper-class models. |
| **Text → speech (TTS)** | `@cf/deepgram/aura-2-en`, `aura-2-es`, `aura-1`, `melotts` (multilingual) | `POST /api/v1/audio/speech` — `{model, input, voice}` → **raw audio bytes**, not JSON (e.g. `openai/gpt-4o-mini-tts-*`, `mistralai/voxtral-mini-tts-*`); multi-speaker input is an array of turns | Cloudflare for reading a card aloud; OpenRouter when the voice quality carries the card. |
| **Translation** | `@cf/meta/m2m100-1.2b`, `indictrans2-en-indic-1B` | any chat model | Cloudflare for bulk/cheap, a chat model when the wording matters. |
| **Turn detection (voice)** | `@cf/pipecat/smart-turn-v2` | not offered | Cloudflare, only if a voice loop gets built. |
| **Safety** | `@cf/meta/llama-guard-3-8b` | provider-dependent | Cloudflare, since it returns the violated categories, not just a flag. |

Newly listed Cloudflare models (`gemma-4-26b-a4b-it`, `glm-5.3`, `deepseek-v4.1-flash-1017`, `kimi-k2.7-code`,
`nemotron-3-120b-a12b`, `phonellm-mini-alpha-2`) are written above in the catalogue's
`@cf/<author>/<slug>` form. I have not called them, so treat their exact ids as unconfirmed until
the first call — a bad id returns an error, it does not silently do the wrong thing.

## What the code does and does not have

`worker.js` today has exactly one OpenRouter shape: a chat completion (`callOpenRouter`, model id or
preset) plus `env.AI.run` for Cloudflare text generation. There is **no** call for embeddings,
reranking, sentiment, ASR or TTS in either provider — those are the "missing code" you pointed at,
not a configuration gap.

So the work per role is genuinely different:

- summarisation, tone, intent — chat shape, so the existing OpenRouter call works with a cheaper
  model; Cloudflare runs through one model id swap;
- embeddings — a different shape on both sides (Cloudflare: `{ text: [...] }` in, `{ data: [[...]] }`
  out; OpenRouter: `{ model, input, dimensions? }` in, OpenAI-style `data[].embedding` out), and
  reranking is `@cf/baai/bge-reranker-base` in the Worker versus `POST /api/v1/rerank` outside it;
- ASR and TTS — different endpoints on each side, not a model swap: `POST /api/v1/audio/transcriptions`
  and `POST /api/v1/audio/speech` on OpenRouter (base64 audio in, raw audio bytes out), `env.AI.run`
  on Cloudflare;
- image and video output — `POST /api/v1/images` and the async `POST /api/v1/videos` on OpenRouter,
  `env.AI.run` on Cloudflare.

## Truth store, from the config you pasted

| Binding | Namespace id | Where it lives now |
| - | - | - |
| `CONTEXT_STORE` | `b78a25e9928e44b3ab0a3e9647a2ee33` | **the same namespace as `cods`' `CONTEXT`** — already shared by id |
| `MASTER_TRUTHS` | `904eff3af4c14f06964e4f651cce9573` | orproxy only; not bound in `cods` |
| `AUDITS` | `8c19918f71fd420d8115e022d3014b9f` | orproxy only; not bound in `cods` |
| `ORP` | `145a30ed3f974dab983eb37d2a5a5a8f` | orproxy only (its own key/config store) |
| `CODS` | service binding → `cods` production | orproxy calling back into `cods` |

That table is the answer to "are the truths saving properly": `cods` cannot see `MASTER_TRUTHS` or
`AUDITS` today, so nothing in `cods` can confirm, count, or curate a truth. Binding those two ids
into `cods` (read first, write later) is what turns "I think it stores them" into something we can
inspect — one binding each, no rewrite of the engine.

## How these paths were checked

Every endpoint above was read from OpenRouter's own docs (`/docs/llms.txt` index, then the
`multimodal/*` pages and the API reference), not from memory. Where a page did not give the
path, the route was probed with an unauthenticated `POST`: `/api/v1/rerank`, `/api/v1/embeddings`,
`/api/v1/audio/speech` and `/api/v1/audio/transcriptions` answer `401` (exists, needs a key),
while a deliberately wrong path answers `404`. An earlier version of this file called OpenRouter
"chat-only" because a scan of `GET /api/v1/models` found no audio or image models — that list is
the **chat** catalogue, so the comparison was blind to the routes that do the other work.

## Every model, by call shape

This is the part that matters for building: a **shape** is a request/response contract, not a
model. `760` models are mapped in [`catalogue.json`](catalogue.json) (machine-readable) and
[`CATALOGUE.md`](CATALOGUE.md) (readable), both generated by `node tools/build-catalogue.mjs`.

| Shape | Cloudflare | OpenRouter | OpenRouter endpoint |
| --- | --- | --- | --- |
| `chat` | 42 | 444 | `POST /api/v1/chat/completions` |
| `embed` | 7 | 42 | `POST /api/v1/embeddings` |
| `rerank` | 1 | 10 | `POST /api/v1/rerank` |
| `image` | 11 | 64 | `POST /api/v1/images` |
| `video` | 0 | 31 | `POST /api/v1/videos, then GET /api/v1/videos/{id}` |
| `stt` | 5 | 29 | `POST /api/v1/audio/transcriptions` |
| `tts` | 4 | 38 | `POST /api/v1/audio/speech` |

* `responses` has no models of its own: it is a **path** available to the 436 OpenRouter models whose
  `media_in` is non-empty (image, audio, file, video). Those ids carry `media_in` in the JSON.
* Cloudflare's shape fixes the **endpoint only**. `env.AI.run` wants `{messages}` for chat models,
  `{prompt}` for text-to-text and image, `{text}` for embeddings, `{audio}` for ASR,
  `{query,contexts}` for the reranker. Same shape, different key — check the model page.
* 32 Cloudflare ids are unclassified because their docs pages publish no task line
  (retired pages: llama-2, qwen1.5, phi-2, tinyllama and friends). They are listed verbatim
  rather than guessed at; anything resolved by id guesswork is marked `id heuristic (unconfirmed)`
  in the JSON, and there are 6 such rows.

**At runtime:** `GET /shapes` returns that card together with the counts and shape descriptions, and `GET /shapes?full=1` returns the whole catalogue. `POST /shapes` with the `x-truth-key` header stores `catalogue.json` at `models/catalogue.json` in the `LTM` bucket, so the list can be refreshed without a redeploy. Until that upload happens the route answers from the built-in card and reports `source: built-in`.

The card is context, not control: clef-flash's typed questions are intent, domain, tone, depth, clarify, needs_web, cache_ok and sensitive, so nothing yet *consumes* a shape when routing. Giving it a `shape` question is the next step, not something this change silently did.

So: if the decision model wants to answer a question, that is `chat` on either side. If it
wants to search its own truths by meaning, that is `embed`. To order candidate truths before
the router sees them, `rerank`. To read a photo of a page, `responses` with `input_image`. To
turn a card into audio, `tts`. The endpoint and body for each are in the two files above.

## clef-flash's window, measured

`clef-flash` has a **24,576-token** context window (Cloudflare's own model page). Probed against the live API on 2026-10-31:

| state | result |
| --- | --- |
| 163 chars | 200, `input_tokens` 165 |
| 96,043 chars | 200, `input_tokens` 19,341 |
| 400,043 chars | **413**, code `5021`: "estimated number of input and maximum output tokens (100056) exceeded this model context window limit (24576)" |

So the platform does **not** trim text state: the request fails. Cloudflare's docs describe truncation to the remaining space, which is true of media tokens and not of a long text state — the probe is the authority here.

What the Worker now does about it:

* `fitState()` budgets the state at **23,000 tokens**, estimated at 3 characters per token (conservative: the probe measured ~4–5). That caps it near 69,000 characters.
* The question is written **first**, as `New message: …`. History follows newest-first, then the shape card, then the learned preferences. If anything is ever cut, it is old context, never the question.
* A 413/`5021` is treated as a window problem, not a broken model: the decision is retried once with `"New message: <prompt>"` alone, and the trail records `state`.
* `GET /health` publishes `clef_context: 24576`, and the decide step reports `trimmed N cards` so a decayed decision is visible rather than silent.

Not covered yet: the *answering* model's own window. `granite-4.0-h-micro` and the rest of the ladder are sent the messages without a budget, and the catalogue does not record Cloudflare context windows yet, so nothing can pick a model that fits a very long input. OpenRouter entries do carry `context`.
