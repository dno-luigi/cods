# Handoff — truth engine work

Written 2026-10-31. This file is the state of the work, not a plan of record. Read it
before touching anything, then ask him before changing code.

## Hard rules (non-negotiable)

- **Never touch a live deployment.** Off limits: the existing front end at
  `ai-n-spired.com`, `i.nspired.cc`, `orproxy`, and every worker currently
  serving traffic. Reading a worker's source through the Cloudflare API is fine.
  Deploying, uploading, deleting or pushing is not. He has said this repeatedly;
  treating a deploy as "just a test" is the failure mode.
- **The brand and the domain are `ai-n-spired.com`.** No second "i" and no "inspired" in it. He has corrected this more than once: copy it from this line, never from memory.
- **Do not create new workers.** He has 58 already. Fix the ones that exist.
- **Ask before changing code.** He gives decisions; he does not want the decision
  handed back to him as a menu of options, and he does not want an assumption made
  in place of a question. One question, then continue.
- **ASR is free forever, for everyone.** No plan check, no key, no login. He pays
  for it because blind users cannot. Never gate dictation.
- **Never grade or critique his legal/methodological output.** He is the method.

## Environment here

Names only — never echo values, never write them into a file:

```
CLOUDFLARE_API_TOKEN   CLOUDFLARE_ID   GITHUB_PAT   OPENROUTER_API_KEY
```

- Repo: `dno-luigi/cods`, branch `freebuff/ba743f3e389746a28967a2fb`.
- The account has 58 workers. Relevant ones: `cods` (this repo), `truth`,
  `truthengine`, `tew`, `truthmem`, `truth-engine-workspace`, `orproxy`,
  `justice`, `asr`, `cards`.

## Model roles (his decision — do not re-derive)

- **Decision first.** `clef-flash` (24,576) → `clef-omni` (64,000) → `clef`
  (65,536), picked by which window holds the state. All three are multimodal
  decision models; clef-omni also reads audio.
- **`@cf/deepseek-ai/deepseek-v4-flash-0731` (1,048,576)** is the coverage layer
  and the answer model. It replaces `granite-4.0-h-micro` everywhere.
- **`@cf/meta/llama-3.2-1b-instruct` (60,000)** is the small assistant working
  beside the decision model and DeepSeek. It is **not** a summariser and is not in
  any rewrite ladder.
- No Kimi, no GLM in the ladders. He never asked for them.
- ASR: `@cf/deepgram/nova-3`, falling back to `@cf/openai/whisper-large-v3-turbo`.
  Both input shapes are tried (`{audio:{body,contentType}}`, then `{audio:[bytes]}`)
  because the accepted shape differs between them.
- Grounding: OpenRouter `web` plugin, `engine: parallel`, `mode: turbo`
  ($1/1,000 requests). Never mention the $5/$7 engines to him.

## cods — what changed and where

Uncommitted in this worktree: `worker.js`, `test.mjs`, `wrangler.jsonc`.

- `worker.js` ~L149 `OR_WEB_PLUGIN`; ~L4867 `openRouterCall` (returns
  `{text, citations}`), `callOpenRouter` kept as a text wrapper.
- ~L4004 the answer path grounds the main call only; card sub-calls do not pay for
  a search. `use_web:false` / `web:false` opt out.
- ~L40 `COMPRESS_LADDER` is DeepSeek alone. ~L181 `CF_TEXT_MODELS` is DeepSeek then
  llama-3.2-1b.
- `POST /stt` — free, no key, `STT_MAX_BYTES` 8 MB, `STT_DAILY_CLIPS` 120 per
  address per day, both models and both shapes tried.
- The page has a mic button (`#mic`) that records, posts to `/stt`, and drops the
  transcript into the prompt for correction.
- `wrangler.jsonc` now binds `TRUTHS` (`904eff3af4c14f06964e4f651cce9573`) and
  `AUDITS` (`8c19918f71fd420d8115e022d3014b9f`). These take effect on a deploy
  only. If a deploy fails because the namespaces are not on the account, comment
  the two entries out — the code prefers `TRUTHS`, never requires it.
- Truth path: `truthStore()` prefers TRUTHS → ARCHIVE → KV; every answer is saved
  as `candidate`, confidence earned 0.4–0.85; `POST /truths/<id>/approve` with
  `x-truth-key` promotes to `master` at 0.9. `GET /truths?status=candidate` lists.
- Checks: `npm run check` (`node --check worker.js`), `npm test` (`node test.mjs`).
  Last run: **371 passed, 0 failed**. Never loosen an assertion to make a model
  change pass — rename the expectation to the new model.

## truth — the separate worker (not in this repo)

Pulled source: `.scratch/truth/worker.js` (1,092 lines, esbuild bundle). Re-pull
any worker with:

```
node tools/pull-worker.mjs truth .scratch/truth
```

Live settings, as read from the API (`/workers/scripts/truth/settings`):

| binding | kind | points at |
| --- | --- | --- |
| `JUSTICE` | service | `justice` |
| `MASTER_TRUTHS` | kv | `904eff3af4c14f06964e4f651cce9573` |
| `PROV_TRUTH` | kv | `4a9bfbffb4d440cba86badc508e2045a` |
| `QC` | durable object | `0a45de46f81b43ac849285d76d117084` |
| `TBACKED` | r2 | (bucket `TBACKED`) |

**Two defects, both known by name:**

1. **No `AI` binding.** Nothing on Workers AI can run in this worker today, so the
   decision models, DeepSeek, llama and ASR are all unreachable from it.
2. **`PROXY` is gone.** The settings annotation reads "Deleted Service binding
   binding PROXY". `requestCandidateFromProxy` (L415) therefore throws
   `PROXY service not bound` on every miss, and `/api/truth/resolve` returns a
   `miss` with `reason: no_master_or_provisional_and_no_valid_candidate`.

Routes: `/api/truth/resolve`, `/master/{create,update,delete}`,
`/provisional/{update,delete,query}`, `/promote`, `/debug/kv-status`. Response
shape is fixed by `canonicalResponse()` — keep it; the front end reads
`status/layer/id/query/answer/source/verified/provisional/eitl/meta/audit`.
`QCLogger` is a Durable Object class exported alongside the handler; it must stay
exported or the binding breaks.

### The port to do (his words: apply what is in cods to the truth worker)

- Add the `AI` binding; keep every existing binding as it is.
- Replace the proxy candidate step with the cods order of work: `decide()`
  (clef ladder by window) → DeepSeek rewrite when the state exceeds the widest
  clef → DeepSeek answer → llama-3.2-1b assistant line. Fill `meta.model`,
  `meta.confidence`, `meta.citations` from that, and save through `setProvisional`.
- Add the free `POST /stt` route and its two models/shapes. Free means free: no
  plan, no key.
- Keep `PROV_TRUTH`'s 24-hour TTL behaviour and the justice notifications.

## Still open, waiting on him

- How a plan/tier is known. Nothing in either worker carries a plan today, so
  gating images/audio/video needs a real signal (account, key or header).
- The login workspace ("save to your own workspace") and its provider.
- Multimodal input: page images into the decision state, then documents.
- The landing page: **new**, and separate from the existing front end.

## Tools in this repo

- `tools/pull-worker.mjs <name> [outDir]` — downloads a deployed worker's modules
  from the Cloudflare API, read-only.
- `tools/build-catalogue.mjs` — rebuilds `catalogue.json` / `CATALOGUE.md`.
- `tools/probe-decisions.mjs` — probe the decisions API shape.
