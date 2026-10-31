// Builds catalogue.json + CATALOGUE.md: every Cloudflare and OpenRouter model, tagged
// with the request/response SHAPE it needs, so a caller knows how to build the call path.
// Public data only: OpenRouter's model index and Cloudflare's docs bundle. No keys.
import { writeFileSync } from "node:fs";

const OR_MODELS = "https://openrouter.ai/api/v1/models";
const CF_DOCS = "https://developers.cloudflare.com/workers-ai/llms-full.txt";
const MODALITIES = ["transcription", "speech", "image", "video", "embeddings", "rerank"];

const SHAPES = {
  chat: {
    endpoint: { openrouter: "POST /api/v1/chat/completions", cloudflare: "env.AI.run(id, input)" },
    request: { openrouter: { model: "<id>", messages: [{ role: "user", content: "..." }], tools: "optional", max_tool_calls: "optional" },
               cloudflare: { messages: [{ role: "user", content: "..." }] } },
    response: { openrouter: "choices[0].message.content", cloudflare: "response" },
    why: "Text in, text out. One body covers every chat-capable id on both sides, so a new model is an id swap.",
  },
  responses: {
    endpoint: { openrouter: "POST /api/v1/responses", cloudflare: "env.AI.run(id, input)" },
    request: { openrouter: { model: "<id>", input: [
      { type: "input_text", text: "..." },
      { type: "input_image", image_url: "https://... or data:image/png;base64,..." },
      { type: "input_file", file_data: "data:application/pdf;base64,..." },
      { type: "input_audio", input_audio: { data: "<base64>", format: "wav" } },
      { type: "input_video", video_url: "..." }] } },
    response: { openrouter: "output[].content[] text parts, plus usage", cloudflare: "varies per model" },
    why: "Mixed media in one request, so a photo or a PDF is not a special case in the router.",
  },
  embed: {
    endpoint: { openrouter: "POST /api/v1/embeddings", cloudflare: "env.AI.run(id, { text: [...] })" },
    request: { openrouter: { model: "<id>", input: "text or [text, ...]", dimensions: "optional" },
               cloudflare: { text: ["..."] } },
    response: { openrouter: "data[].embedding (float[])", cloudflare: "data (float[][])" },
    why: "Vectors out. Dimensions differ per model, so the model id must be stored beside the vector.",
  },
  rerank: {
    endpoint: { openrouter: "POST /api/v1/rerank", cloudflare: "env.AI.run(id, input)" },
    request: { openrouter: { model: "<id>", query: "...", documents: ["...", "..."], top_n: 3 },
               cloudflare: { query: "...", contexts: [{ text: "..." }] } },
    response: { openrouter: "results[] of { index, relevance_score, document.text }", cloudflare: "response[] of { id, score }" },
    why: "Ordering only. Scores come back, so you keep your own records and re-sort instead of trusting its text.",
  },
  image: {
    endpoint: { openrouter: "POST /api/v1/images", cloudflare: "env.AI.run(id, { prompt })" },
    request: { openrouter: { model: "<id>", prompt: "...", n: "optional", size: "optional" },
               cloudflare: { prompt: "..." } },
    response: { openrouter: "data[].b64_json or data[].url", cloudflare: "image (base64 png/jpg)" },
    why: "Binary out, so it can never be a chat turn; the card has to carry the image.",
  },
  video: {
    endpoint: { openrouter: "POST /api/v1/videos, then GET /api/v1/videos/{id}", cloudflare: "not offered" },
    request: { openrouter: { model: "<id>", prompt: "...", image: "optional reference frame", webhook: "optional" } },
    response: { openrouter: "job id at once; poll status, then an output URL" },
    why: "Asynchronous. Never block a Worker request on it: needs a job record plus poll or webhook.",
  },
  stt: {
    endpoint: { openrouter: "POST /api/v1/audio/transcriptions", cloudflare: "env.AI.run(id, { audio })" },
    request: { openrouter: { model: "<id>", input_audio: { data: "<base64 raw bytes>", format: "wav|mp3|m4a|ogg|webm|flac|aac" },
                             language: "optional", response_format: "json or verbose_json", timestamp_granularities: "optional" },
               cloudflare: { audio: "<base64 string or byte array>" } },
    response: { openrouter: "{ text, usage }", cloudflare: "{ text }" },
    why: "Audio in, text out. The one shape whose input is not text.",
  },
  tts: {
    endpoint: { openrouter: "POST /api/v1/audio/speech", cloudflare: "env.AI.run(id, { text })" },
    request: { openrouter: { model: "<id>", input: "text or [{ speaker, text }]", voice: "<voice id>" },
               cloudflare: { text: "...", speaker: "optional" } },
    response: { openrouter: "raw audio bytes (NOT json)", cloudflare: "{ audio: base64 }" },
    why: "Raw bytes out: must not be JSON-decoded, and on Cloudflare it arrives base64 inside JSON.",
  },
};

const getText = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": "cods-catalogue/1" } });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.text();
};
const getJson = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": "cods-catalogue/1" } });
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.json();
};

function cfShape(task) {
  if (!task) return "unknown";
  const t = task.toLowerCase();
  const map = [
    ["text-to-speech", "tts"], ["text to speech", "tts"],
    ["automatic speech recognition", "stt"], ["speech-to-text", "stt"], ["speech to text", "stt"],
    ["rerank", "rerank"],
    ["embedding", "embed"],
    ["text-to-image", "image"], ["text to image", "image"], ["image-to-image", "image"],
    ["image generation", "image"], ["inpainting", "image"], ["text-to-video", "video"],
    ["image-to-text", "chat"], ["image classification", "chat"], ["object detection", "chat"],
    ["image segmentation", "chat"], ["vision", "chat"],
    ["text generation", "chat"], ["text-to-text", "chat"], ["text classification", "chat"],
    ["translation", "chat"], ["summarization", "chat"], ["conversational", "chat"],
    ["reasoning", "chat"], ["function calling", "chat"],
  ];
  for (const [needle, shape] of map) if (t.includes(needle)) return shape;
  return "unknown";
}

// Only used when the docs page gave no task line; every use is flagged in shape_source.
const ID_HEURISTIC = [
  [/embed/i, "embed"],
  [/rerank/i, "rerank"],
  [/whisper|nova-|smart-turn|asr/i, "stt"],
  [/aura-|melotts|tts|voice/i, "tts"],
  [/stable-diffusion|flux-|lucid|phoenix|dreamshaper|seedream|image/i, "image"],
  [/video|wan-|hailuo/i, "video"],
];

async function cfModels(text) {
  const out = new Map();
  // A model page is: a heading, a blank line, "Task • Author", then the id.
  const pageRe = /^# (.+)\n\n([A-Z][A-Za-z0-9 /&'+-]{2,42}) • ([^\n]{2,70})$/gm;
  let match;
  while ((match = pageRe.exec(text)) !== null) {
    const idMatch = text.slice(match.index, match.index + 4000).match(/@cf\/[A-Za-z0-9._/-]+/);
    if (!idMatch) continue;
    const id = idMatch[0].replace(/[.,)]+$/, "");
    if (out.has(id)) continue;
    const task = match[2].trim();
    // The docs label bge-reranker-base "Text Classification"; its id is the truth.
    const rerankOverride = /rerank/i.test(id) && cfShape(task) !== "rerank";
    out.set(id, { id, provider: "cloudflare", task, author: match[3].trim(),
                  shape: rerankOverride ? "rerank" : cfShape(task),
                  shape_source: rerankOverride ? "docs model page (id overrides task label)" : "docs model page" });
  }
  for (const raw of text.match(/@cf\/[A-Za-z0-9._/-]+/g) || []) {
    const id = raw.replace(/[.,)]+$/, "");
    if (out.has(id)) continue;
    out.set(id, { id, provider: "cloudflare", task: null, author: null, shape: "unknown", shape_source: "unknown" });
  }
  // Legacy pages carry no task line in the bundle; ask each model page directly.
  for (const model of out.values()) {
    if (model.shape !== "unknown") continue;
    const slug = model.id.split("/").pop();
    try {
      const page = await getText("https://developers.cloudflare.com/workers-ai/models/" + encodeURIComponent(slug) + "/index.md");
      const hit = page.match(/^# (.+)\n\n([A-Z][A-Za-z0-9 /&'+-]{2,42}) • ([^\n]{2,70})$/m);
      if (hit) {
        model.task = hit[2].trim();
        model.author = hit[3].trim();
        model.shape = /rerank/i.test(model.id) ? "rerank" : cfShape(model.task);
        model.shape_source = "docs model page (fetched per model)";
        continue;
      }
    } catch {
      // fall through to the id heuristic, which stays flagged
    }
    const guess = ID_HEURISTIC.find(([re]) => re.test(model.id));
    if (guess) { model.shape = guess[1]; model.shape_source = "id heuristic (unconfirmed)"; }
  }
  return [...out.values()];
}

// An OpenRouter model's shape comes from which output index lists it; strongest wins,
// because an image-output model that also answers chat is still called through /images.
const SHAPE_RANK = ["chat", "responses", "image", "video", "stt", "tts", "embed", "rerank"];

function orModels(byModality) {
  const seen = new Map();
  const add = (model, shape) => {
    const prev = seen.get(model.id);
    if (prev && SHAPE_RANK.indexOf(shape) <= SHAPE_RANK.indexOf(prev.shape)) return;
    seen.set(model.id, {
      id: model.id,
      provider: "openrouter",
      shape,
      context: model.context_length ?? null,
      price_prompt: model.pricing?.prompt ?? null,
      in: model.architecture?.input_modalities ?? null,
      out: model.architecture?.output_modalities ?? null,
      // media input is what makes the `responses` shape usable for this model
      media_in: (model.architecture?.input_modalities ?? []).filter((m) => ["image", "audio", "file", "video"].includes(m)),
      shape_source: "output_modalities index",
    });
  };
  for (const model of byModality.chat) add(model, "chat");
  for (const model of byModality.transcription) add(model, "stt");
  for (const model of byModality.speech) add(model, "tts");
  for (const model of byModality.image) add(model, "image");
  for (const model of byModality.video) add(model, "video");
  for (const model of byModality.embeddings) add(model, "embed");
  for (const model of byModality.rerank) add(model, "rerank");
  return [...seen.values()];
}

const [orAll, cfDocs] = await Promise.all([getJson(OR_MODELS), getText(CF_DOCS)]);
const byModality = { chat: orAll.data ?? [] };
for (const modality of MODALITIES) {
  try {
    byModality[modality] = (await getJson(OR_MODELS + "?output_modalities=" + modality)).data ?? [];
  } catch (err) {
    byModality[modality] = [];
    console.error("modality index failed:", modality, err.message);
  }
}

const models = [...orModels(byModality), ...(await cfModels(cfDocs))];
const byShape = {};
for (const model of models) byShape[model.shape] = (byShape[model.shape] || 0) + 1;

const catalogue = {
  generated: new Date().toISOString(),
  sources: {
    openrouter_models: OR_MODELS,
    openrouter_modality_index: OR_MODELS + "?output_modalities=<transcription|speech|image|video|embeddings|rerank>",
    cloudflare_docs: CF_DOCS,
    verification: "Model lists are public and were fetched, not recalled. Shapes come from each vendor's own task/metadata fields; anything guessed is marked in shape_source.",
    cloudflare_input_keys: "Shape gives the endpoint, not the payload: Cloudflare's env.AI.run input object key varies per model even inside one shape — {messages} for chat models, {prompt} for text-to-text and image, {text} for embeddings and some TTS, {audio} for ASR, {query,contexts} for rerankers. Confirm the key on the model's docs page before wiring one.",
  },
  shapes: SHAPES,
  counts: {
    openrouter: models.filter((m) => m.provider === "openrouter").length,
    cloudflare: models.filter((m) => m.provider === "cloudflare").length,
    by_shape: byShape,
  },
  models,
};
writeFileSync("catalogue.json", JSON.stringify(catalogue, null, 1) + "\n");
console.log("wrote catalogue.json", JSON.stringify(catalogue.counts));

const lines = [];
const pick = (provider, shape) => models.filter((m) => m.provider === provider && m.shape === shape);
lines.push("# Model catalogue", "");
lines.push("Generated by `node tools/build-catalogue.mjs` from the vendors' public model lists.");
lines.push("Do not hand-edit: rerun the generator when models change.", "");
lines.push("**" + catalogue.counts.openrouter + "** OpenRouter models and **" + catalogue.counts.cloudflare + "** Cloudflare models,");
lines.push("each tagged with the **shape** of call it needs. A shape is a call path, not a model.");
lines.push("If a model is `embed`, it needs the embeddings body — sending `messages` to it will fail.", "");
lines.push("> Cloudflare caveat: the shape fixes the **endpoint**, not the payload key. `env.AI.run` takes");
lines.push("> `{messages}` for chat models but `{prompt}` for text-to-text and image, `{text}` for embeddings,");
lines.push("> `{audio}` for ASR, `{query,contexts}` for rerankers. Check the model page before wiring one.", "");
lines.push("| Shape | Cloudflare | OpenRouter | Endpoint (OpenRouter) | Endpoint (Cloudflare) |");
lines.push("| --- | --- | --- | --- | --- |");
for (const [name, spec] of Object.entries(SHAPES)) {
  lines.push("| `" + name + "` | " + (pick("cloudflare", name).length || "-") + " | " + (pick("openrouter", name).length || "-") +
    " | `" + spec.endpoint.openrouter + "` | `" + spec.endpoint.cloudflare + "` |");
}
const unknown = models.filter((m) => m.shape === "unknown");
lines.push("");
lines.push("Unclassified: **" + unknown.length + "**" + (unknown.length ? " — " + unknown.map((m) => m.id).join(", ") : ""));
const guessed = models.filter((m) => String(m.shape_source).indexOf("heuristic") === 0);
lines.push("Shape guessed from the id (not confirmed by the vendor's task field): **" + guessed.length + "**" +
  (guessed.length ? " — " + guessed.map((m) => m.id).join(", ") : ""));
lines.push("");
for (const [name, spec] of Object.entries(SHAPES)) {
  lines.push("## " + name, "");
  lines.push("Why: " + spec.why, "");
  lines.push("```json");
  lines.push(JSON.stringify({ endpoint: spec.endpoint, request: spec.request, response: spec.response }, null, 1));
  lines.push("```", "");
  for (const provider of ["cloudflare", "openrouter"]) {
    const list = pick(provider, name).map((m) => m.id);
    if (!list.length) { lines.push("- **" + provider + "** (0): none"); continue; }
    const head = list.slice(0, 40).map((id) => "`" + id + "`").join(", ");
    lines.push("- **" + provider + "** (" + list.length + "): " + head + (list.length > 40 ? ", … +" + (list.length - 40) + " more in catalogue.json" : ""));
  }
  lines.push("");
}
writeFileSync("CATALOGUE.md", lines.join("\n") + "\n");
console.log("wrote CATALOGUE.md");
