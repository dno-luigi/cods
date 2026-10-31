# Model map — Cloudflare Workers AI vs OpenRouter

Two providers, two different call shapes, and they do not overlap as much as they look.

- **Cloudflare** (`env.AI.run(id, inputs)`) — one binding, typed inputs per task, billed per unit.
  Model ids are `@cf/<author>/<slug>`. A wrong id fails loudly on the call, so each one below is
  safe to try before wiring.
- **OpenRouter** (`POST https://openrouter.ai/api/v1/chat/completions`) — one key on `cods`
  (`OPENROUTER_API_KEY`), one shape for every model, plus presets as `@preset/<name>`.
  Its catalogue is chat-shaped: audio in, audio out, image out, text out — **no embeddings, no
  reranking, no transcription** (456 models listed, zero embedding entries).

Source lists, pulled 31 Oct 2026: `developers.cloudflare.com/workers-ai/models/index.md` (73 models)
and `openrouter.ai/api/v1/models` (456 models).

## Roles

| Role | Cloudflare | OpenRouter | What I'd use, and why |
| - | - | - | - |
| **Router / decision** | `@cf/cloudflare/clef-flash` (current), `clef`, `clef-omni` (audio + video in) | any cheap chat model, but nothing returns per-option probabilities | **clef-flash**. It is a decision model: state plus a schema of typed questions in, a probability for every option out. A chat model needs a JSON contract and still gives one answer, not a distribution — that's the whole reason the card loop works. |
| **Router fallback (big context)** | `@cf/deepseek-ai/deepseek-v4-pro-0813` (1M), `@cf/moonshotai/kimi-k2.6` (262k), `@cf/zai-org/glm-5.3` (1M) | `particle-ai/particle-1` (1.05M), `openai/gpt-6.1-terra` (1.05M), `minimax/minimax-m3.1-flash` (1.05M) | Whatever clef-flash cannot fit goes here and the card says the router changed. |
| **Answer / generation** | `@cf/ibm-granite/granite-4.0-h-micro` (**current default, unchanged**), `llama-3.3-70b-instruct-fp8-fast`, `gpt-oss-120b`, `glm-5.3` | whatever the picker names: `openai/gpt-4o-mini`, `deepseek/deepseek-v3.1`, `google/gemini-flash`, `anthropic/claude-haiku`, `meta-llama/llama-70b`, plus `@preset/truth` | Cloudflare stays the default; OpenRouter answers when chosen. |
| **Summarisation** | `@cf/meta/llama-3.2-3b-instruct` (default), `llama-3.2-1b-instruct` (cheapest) | `z-ai/glm-5.2` ($0.006/M prompt), `openai/gpt-oss-20b`, `inclusionai/ling-3.0-flash` | Cheap and separate from the answerer, so card copy never costs an answer-model call. |
| **Embeddings** | `@cf/baai/bge-m3` (multilingual, best default), `bge-large-en-v1.5` (1024d), `bge-small-en-v1.5` (384d), `qwen3-embedding-0.6b`, `embeddinggemma-300m` (beta), `plamo-embedding-1b` (Japanese) | **none** | Cloudflare only. This is what makes similar questions cluster instead of exact-match hits. |
| **Reranking** | `@cf/baai/bge-reranker-base` (query + passage → relevance) | **none** | Cloudflare only, and it is the cheap way to order retrieved truths before they hit the router. |
| **Tone / feeling** | `@cf/huggingface/distilbert-sst-2-int8` (POSITIVE/NEGATIVE + score), `llama-guard-3-8b` (safety categories) | any cheap chat model prompted for JSON (`z-ai/glm-5.2`, `openai/gpt-oss-20b`) | distilbert on every request as the free-ish signal; a chat model only when the router asks for nuance (frustration, urgency). |
| **Intent / domain** | clef itself (typed questions with probabilities), plus embeddings for nearest-known-intent | cheap chat model with a JSON schema | clef first: it already returns the distribution, so intent is a question in the schema rather than another call. |
| **Image generation** | `@cf/black-forest-labs/flux-1-schnell`, `flux-2-klein-4b`, `flux-2-klein-9b`, `flux-2-dev`, `lucid-origin`, `phoenix-1.0`, `dreamshaper-8-lcm`, `stable-diffusion-xl-base-1.0`, `stable-diffusion-v1-5-inpainting` | `google/gemini-3.1-flash-image`, `google/gemini-3-pro-image`, `google/gemini-nano-banana-2.1`, `openai/gpt-5.4-image-2` | Cloudflare for cheap/fast; OpenRouter when quality matters and it is a card worth paying for. |
| **Image understanding** | `@cf/meta/llama-3.2-11b-vision-instruct`, `llama-4-scout-17b-16e-instruct`, `llava-1.5-7b-hf`, `moondream3.1-9B-A2B` (OCR, pointing), `mistral-small-3.1-24b-instruct` | any multimodal chat model (vision input is common across the 456) | Cloudflare `moondream` for OCR-ish card work, `llama-3.2-11b-vision` for describing. |
| **Speech → text (ASR)** | `@cf/deepgram/nova-3`, `@cf/deepgram/flux` (conversational) | **no transcription endpoint** — 45 models accept audio input and answer in text, which is not a transcript | Cloudflare. If you want to talk to the cards, this is the one path. |
| **Text → speech (TTS)** | `@cf/deepgram/aura-2-en`, `aura-2-es`, `aura-1`, `melotts` (multilingual) | `openai/gpt-audio`, `openai/gpt-audio-mini`, `google/lyria-3-*` (music) | Cloudflare for reading a card aloud; OpenRouter audio-out for anything musical. |
| **Translation** | `@cf/meta/m2m100-1.2b`, `indictrans2-en-indic-1B` | any chat model | Cloudflare for bulk/cheap, a chat model when the wording matters. |
| **Turn detection (voice)** | `@cf/pipecat/smart-turn-v2` | none | Cloudflare, only if a voice loop gets built. |
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
- embeddings and reranking — a different request *and* response shape (`{ text: [...] }` in,
  `{ data: [[...]] }` out), and OpenRouter cannot do them at all;
- ASR and TTS — audio bodies, base64 or binary, and streaming concerns that the current
  request path has no idea about.

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
