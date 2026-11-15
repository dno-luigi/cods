# How cods calls Cloudflare for decisions and inference

Kept here so the same calls can be replicated elsewhere without re-deriving them from the worker.
Every shape below is quoted from `worker.js` as it is today; nothing here is aspirational.

## Decision (`decide`)

Binding: `env.AI`. Ladder, smallest window first — `DECISION_LADDER`, `worker.js:22-27`:

| id passed to `env.AI.run` | `model` field | context |
|---|---|---|
| `@cf/cloudflare/clef-flash` | `clef-flash` | 24,576 |
| `@cf/cloudflare/clef-omni` | `clef-omni` | 64,000 |
| `@cf/cloudflare/clef` | `clef` | 65,536 |

Two rules that are easy to lose:

- **`model` must be the short name.** The endpoint validates it against `^\s*clef(-omni|-flash)?\s*$`
  and rejects the `@cf/…` id. `id` and `model` are two different fields for that reason.
- **The platform does not trim the state for you.** Over the window it returns `413` with code
  `5021`; the caller picks the smallest ladder entry that holds `tokens + DECISION_RESERVE`
  (1,500), and only a window refusal moves it up (`/context window|5021|too large|exceeded/i`).

Call shape — `worker.js:4064`:

```js
await env.AI.run(entry.id, { model: entry.model, state, questions });
```

`state` is the prompt text with the principles closed onto the end and the decide-stage rules
appended; `questions` is the typed schema (`noul`, `choice`, `score`). Answers come back per
question with probabilities and confidence, and are read through `readProbability` /
`readChoice` / `readScore` (`worker.js:4085-4103`).

When nothing on Cloudflare holds the state, the same `state`/`questions` go to OpenRouter's
decisions API — **not** the chat endpoint, and no chat SDK works against it (`worker.js:4104-4121`):

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
{ "model": "<model>", "state": "<text>", "questions": { ... } }
```

OpenRouter ladder: `nace-ai/drex-max`, `perplexity/pplx-decider-flash-v1.2`, `liquid/d1.1`.
A model whose own reported input tokens are far below the state's estimated size is passed over —
it sliced the input, and a confident answer about a slice is worse than none.

## Inference (answer text)

Binding: `env.AI`, tried before OpenRouter in the chat path — `worker.js:7131-7146`:

```js
await env.AI.run(cfModel, { messages, max_tokens, temperature });
```

- `messages` is built by `withPrinciples(messages)` first, so the principles travel with every call.
- Response is read with `textFrom(aiResponse)`; an empty `text` counts as a failure and the next
  model is tried.
- The trace records `source: "workers-ai"`, `model: cfModel`, and the provider string is
  `"clef-flash → " + cfModel`.

## State compression (used when the state will not fit)

`compressState` (`worker.js:62-90`): `env.CF_SUMMARIZER` first when set, then `COMPRESS_LADDER`.
Skip an entry when `need > entry.context - 2000`. Shape:

```js
await env.AI.run(entry.model, {
  messages: [{ role: "system", content: compressInstructions(budget) }, { role: "user", content: raw }],
  max_tokens: 2000,
  temperature: 0.2
});
```

## The endpoint fixes the payload key

`worker.js:202`, and this is the part that breaks replications: Cloudflare decides what the second
argument looks like, and it differs per task.

| Task | Payload |
|---|---|
| text-to-text, image | `{ prompt }` |
| embeddings | `{ text }` |
| ASR | `{ audio }` |
| reranker | `{ query, contexts }` |
| chat-shaped (decisions, inference, compression) | `{ messages }` or `{ model, state, questions }` |

A replication that sends `{ prompt }` to a model that wants `{ messages }` gets a 5007
"no such model … or task", and one that sends the `@cf/` id where the short name is validated
gets a 4xx. Those two are the failures this file exists to prevent.
