// cards — single entrypoint, inline frontend
//
// Pipeline per card:
//   1. cache      — has this already been answered?
//   2. decide     — clef-flash classifies intent / domain / need-for-web / care / depth / tone
//   3. search     — Cloudflare Web Search API (env.AI.websearch) when the decision says the web is needed
//   4. answer     — OpenRouter or a Workers AI chat model, grounded in the sources
//
// Bindings: AI (clef-flash + websearch), KV (answer cache)
const cH = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CLEF_MODEL = "@cf/cloudflare/clef-flash";
// clef-flash reads a 24,576-token window. The platform does not trim text state
// for you: it answers 413 with code 5021 ("exceeded this model context window
// limit"), which used to lose the decision entirely. So the state is budgeted
// here, and the question is placed first: whatever else is dropped, clef still
// sees what was actually asked.
const CLEF_CONTEXT_TOKENS = 24576;
const CLEF_STATE_TOKENS = 23000;
// ~3 characters per token for mixed prose and JSON. It over-estimates English
// and stays under the limit for code, where tokens are denser.
const CHARS_PER_TOKEN = 3;

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / CHARS_PER_TOKEN);
}

function fitState(sections) {
  const budget = CLEF_STATE_TOKENS;
  const prompt = String((sections && sections.prompt) || "");
  let head = "New message:\n" + prompt;
  let promptCut = false;
  if (estimateTokens(head) > budget) {
    const room = budget * CHARS_PER_TOKEN - "New message:\n".length - 24;
    head = "New message:\n" + prompt.slice(0, Math.max(0, room)) + " ...(cut to fit)";
    promptCut = true;
  }
  const parts = [head];
  let used = estimateTokens(head);
  const lines = [];
  let dropped = 0;
  const cards = ((sections && sections.told) || []).slice().reverse();
  for (const card of cards) {
    const line = "User: " + card.q + "\nAssistant: " + (card.a || card.r || "(no reply)");
    const cost = estimateTokens(line);
    if (used + cost > budget - 400) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += cost;
  }
  if (lines.length) parts.push("Conversation so far (newest first):\n" + lines.join("\n\n"));
  const card = String((sections && sections.card) || "");
  if (card && used + estimateTokens(card) <= budget) {
    parts.push(card);
    used += estimateTokens(card);
  }
  const learned = String((sections && sections.learned) || "");
  if (learned && used + estimateTokens(learned) <= budget) {
    parts.push(learned);
    used += estimateTokens(learned);
  }
  return { state: parts.join("\n\n"), tokens: used, dropped, promptCut, trimmed: dropped > 0 || promptCut };
}

const OR_MODELS = ["openai/gpt-4o-mini"];

// OpenRouter models the picker offers. With OPENROUTER_API_KEY these go
// straight to the API, so any model id works. A preset is just a name too:
// OpenRouter accepts "@preset/<slug>" as the model, and the proxy rewrites a
// bare name to exactly that.
const OR_CHOICES = [
  { id: "deepseek/deepseek-chat-v3.1", short: "deepseek v3.1", label: "DeepSeek V3.1 — cheap and strong" },
  { id: "openai/gpt-4o-mini", short: "gpt-4o-mini", label: "GPT-4o mini — dependable" },
  { id: "google/gemini-2.0-flash-001", short: "gemini flash", label: "Gemini 2.0 Flash — very fast" },
  { id: "anthropic/claude-3.5-haiku", short: "haiku", label: "Claude 3.5 Haiku — good writing" },
  { id: "meta-llama/llama-3.3-70b-instruct", short: "llama 70B", label: "Llama 3.3 70B — open weights" },
];
const WEB_THRESHOLD = 0.5;
const CARE_THRESHOLD = 0.5;
// How many times the decision layer may ask before it answers anyway.
const CLARIFY_ROUNDS = 2;
// Between these two it genuinely cannot tell whether the web would help, so
// that is worth one question rather than a guess.
const WEB_ASK_LOW = 0.35;
const WEB_ASK_HIGH = 0.7;
const STABLE_THRESHOLD = 0.55;
const TTL_STABLE = 604800; // 7 days
const TTL_VOLATILE = 3600; // 1 hour

// Text layer: Workers AI models in this order, then OpenRouter.
const CF_TEXT_MODELS = ["@cf/ibm-granite/granite-4.0-h-micro"];

// The shapes: what a call has to look like, not which model answers it. The
// card stays short because it rides in clef-flash's state; the full per-model
// catalogue is a file in R2 served by /shapes, and no prompt should ever
// carry all 760 ids.
const SHAPES_KEY = "models/catalogue.json";
const SHAPE_CARD = [
  "Call shapes, and what each one needs:",
  "chat \u2014 text in, text out. OpenRouter POST /api/v1/chat/completions {model,messages}; Cloudflare env.AI.run(id,{messages}).",
  "embed \u2014 POST /api/v1/embeddings {model,input}. Vectors out; dimensions differ, so store the id with the vector.",
  "rerank \u2014 POST /api/v1/rerank {model,query,documents,top_n}. Scores and order out, the records stay yours.",
  "image \u2014 POST /api/v1/images {model,prompt}. Image bytes out, so it can never be a chat turn.",
  "video \u2014 POST /api/v1/videos then GET /api/v1/videos/{id}. Asynchronous: never block a request on it.",
  "stt \u2014 POST /api/v1/audio/transcriptions {model,input_audio:{data,format}}. Text out.",
  "tts \u2014 POST /api/v1/audio/speech {model,input,voice}. Raw audio bytes out, not JSON.",
  "responses \u2014 POST /api/v1/responses with input[] parts of text, image, file or audio.",
  "Cloudflare fixes the endpoint only: env.AI.run wants {prompt} for text-to-text and image, {text} for embeddings, {audio} for ASR, {query,contexts} for the reranker.",
].join("\n");


// What the picker on the phone offers. Cloudflare models need no key, so they
// come first; a proxy preset is the OpenRouter route. A pick this account
// cannot run falls through the chain, so the answer still arrives.
const MODEL_CHOICES = [
  { id: "@cf/ibm-granite/granite-4.0-h-micro", short: "granite", label: "Granite 4 micro — fastest" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", short: "llama 70B", label: "Llama 3.3 70B — strongest here" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", short: "qwen 32B", label: "Qwen 2.5 32B — code and maths" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", short: "mistral 24B", label: "Mistral Small 3.1 24B" },
];

function proxyPresets(env) {
  const raw = String(env.ORPROXY_PRESETS || "").trim();
  if (!raw) return [env.ORPROXY_PRESET || OR_PROXY_PRESET];
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

// One card per web result, so a search fills the grid.
const CARD_LIMIT = 3;

// Cloudflare AI Search, public endpoint of the cards instance.
//   POST /search            -> the notes: what the cards already know (human side)
//   POST /chat/completions  -> the model's end: ask the notes, and write new ones
const AI_SEARCH_URL = "https://ebfc217f-98c4-40f7-9ca8-324549e4571c.search.ai.cloudflare.com";
const AI_SEARCH_INSTANCE = "NSM";

// Domain packs kept in code, so the router carries its own context for the
// domains it sees most. `web` is the prior that live sources help; `noWeb`
// pins a domain to reasoning only.
const DOMAINS = {
  general: {
    label: "General",
    web: 0.3,
    guidance: "Answer from general knowledge.",
  },
  logic: {
    label: "Logic / formal reasoning",
    web: 0.05,
    noWeb: true,
    guidance:
      "Treat this as formal reasoning: state the premises explicitly, derive the answer step by step, then verify the conclusion against the premises.",
    principles: ["Do not fetch sources for a self-contained argument.", "Check the result twice before answering."],
  },
  math: {
    label: "Math",
    web: 0.05,
    noWeb: true,
    guidance:
      "Show the calculation step by step, keep units, and sanity-check the magnitude of the result before stating it.",
  },
  code: {
    label: "Code",
    web: 0.35,
    guidance:
      "Give runnable code in fenced blocks, name the language, and note any assumption or version constraint.",
    principles: ["Prefer the standard library.", "Mention edge cases that would change the code."],
  },
  medical: {
    label: "Medical",
    web: 0.6,
    risk: true,
    stable: false,
    guidance: "Give general health information only.",
    safety:
      "Never diagnose, never give dosages, and never present this as medical advice. Recommend a qualified clinician, and for anything urgent point to emergency services.",
  },
  legal: {
    label: "Legal",
    web: 0.6,
    risk: true,
    stable: false,
    guidance: "Give general legal information only, and name the jurisdiction when it matters.",
    safety:
      "Do not present this as legal advice. Recommend a qualified lawyer for anything that affects the user's rights or obligations.",
  },
  finance: {
    label: "Finance",
    web: 0.6,
    risk: true,
    stable: false,
    guidance: "Give general financial information only.",
    safety:
      "Do not present this as investment, tax, or accounting advice. Recommend a licensed professional for decisions that involve money.",
  },
  safety: {
    label: "Safety / legality",
    web: 0.2,
    risk: true,
    stable: false,
    guidance: "Answer at the level of risk and law, not of method.",
    safety:
      "Do not give instructions that would enable harm or a crime. Explain why it is restricted and describe a lawful alternative.",
  },
  news: {
    label: "Current events",
    web: 0.95,
    stable: false,
    guidance:
      "Base the answer on the sources provided, note how recent they are, and say plainly when they do not settle the question.",
  },
  research: {
    label: "Research / reference",
    web: 0.8,
    stable: false,
    guidance:
      "Ground claims in the provided sources, cite them as [n], and separate what the sources say from your own inference.",
  },
  howto: {
    label: "How-to",
    web: 0.4,
    guidance: "Answer as ordered, actionable steps.",
  },
};

// Typed questions handed to clef-flash. Answers come back keyed by these ids.
const QUESTIONS = {
  // The decision model cannot generate, and that is fine: what it can do is say
  // what kind of call the request needs. Code then picks a model that can make
  // that call. Shapes outlive model ids, so this list does not go stale.
  shape: {
    type: "choice",
    instructions: "What kind of call answers this prompt?",
    criteria: {
      chat: "Text in, text out: an answer, explanation, judgement or steps",
      embed: "Turning text into vectors, for finding things by meaning",
      rerank: "Ordering a known set of passages by relevance",
      image: "Producing a picture",
      video: "Producing a moving clip",
      stt: "Turning speech into text",
      tts: "Turning text into speech",
    },
  },
  intent: {
    type: "choice",
    instructions: "What does the user want out of this prompt?",
    criteria: {
      answer: "A direct answer, explanation, or fact",
      list: "A set of items, options, or ideas",
      build: "Code, markup, or another concrete artifact",
      decide: "A judgement or recommendation between alternatives",
      meta: "A question about this app, the model, or the conversation so far",
    },
  },
  domain: {
    type: "choice",
    instructions: "Which domain does this prompt belong to?",
    criteria: {
      general: "Everyday questions with no special field",
      logic: "A self-contained argument, puzzle, or reasoning problem",
      math: "Arithmetic, algebra, statistics, or other calculation",
      code: "Programming, debugging, tooling, or configuration",
      medical: "Health, symptoms, medication, or clinical questions",
      legal: "Law, contracts, rights, or obligations",
      finance: "Money, investing, tax, or accounting",
      safety: "Something harmful, illegal, or dangerous",
      news: "Recent events, prices, releases, or other time-sensitive facts",
      research: "A factual question that benefits from sources",
      howto: "A procedure the user wants to carry out",
    },
  },
  needs_web: {
    type: "noul",
    instructions:
      "Does answering accurately require current information from the internet (news, prices, releases, live data, recent events)?",
  },
  cache_ok: {
    type: "noul",
    instructions:
      "Is this a stable question whose answer is unlikely to have changed, so a cached answer would still be correct?",
  },
  sensitive: {
    type: "noul",
    instructions:
      "Does this touch medical, legal, financial, or safety-sensitive ground where extra care is required?",
  },
  depth: {
    type: "score",
    instructions: "How much depth does a good answer need here?",
    criteria: ["One line", "A short paragraph", "A full explanation", "A deep, structured dive"],
  },
  tone: {
    type: "choice",
    instructions: "Which register fits this prompt?",
    criteria: {
      plain: "Neutral, everyday language",
      technical: "Precise, engineering language",
      warm: "Friendly and conversational",
    },
  },
};

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>kards</title>
<style>
:root{--bg:#101014;--panel:#16161d;--card:#1c1c25;--line:#2c2c38;--text:#f2f2f6;--dim:#8d8d9a;--p:#c41e3a;--sel:#3a1620}
body.light{--bg:#f3f3f7;--panel:#fff;--card:#fff;--line:#dcdce6;--text:#15151b;--dim:#66667a;--sel:#ffe3e8}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.top{padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex:0 0 auto}
.top h1{font-size:17px;color:var(--p);letter-spacing:.02em}
.badge{background:var(--p);color:#fff;border-radius:12px;padding:2px 8px;font-size:12px}
.grow{flex:1}
.icon{background:none;border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer}
.icon.on{color:#fff;background:var(--p);border-color:var(--p)}
.cards{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;cursor:pointer;overflow:hidden;flex:0 0 auto}
.card.flipped{border-color:var(--p)}
.card.sel{border-color:var(--p);background:var(--sel)}
.fh{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 0}
.lab{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.acts{display:flex;gap:8px}
.dots{font-size:15px;color:var(--dim);cursor:pointer;line-height:1}
.face{display:none;animation:pop .16s ease-out}
.card:not(.flipped) .front{display:block}
.card.flipped .back{display:block}
@keyframes pop{from{opacity:.2;transform:translateY(3px)}to{opacity:1;transform:none}}
.body{padding:8px 14px 12px;font-size:14px;line-height:1.55;word-break:break-word}
.card-q{white-space:pre-wrap;font-size:15px}
.card-a{white-space:normal}
:is(.card-a,.fs-body){-webkit-user-select:text;user-select:text;overflow-wrap:anywhere}
:is(.card-a,.fs-body) p{margin:0 0 10px}
:is(.card-a,.fs-body)>:first-child{margin-top:0}
:is(.card-a,.fs-body)>:last-child{margin-bottom:0}
:is(.card-a,.fs-body) h2,:is(.card-a,.fs-body) h3,:is(.card-a,.fs-body) h4{margin:15px 0 7px;line-height:1.3;font-weight:680;letter-spacing:.01em}
:is(.card-a,.fs-body) h2{font-size:17px}
:is(.card-a,.fs-body) h3{font-size:15.5px}
:is(.card-a,.fs-body) h4{font-size:13.5px;color:var(--dim)}
:is(.card-a,.fs-body) ul,:is(.card-a,.fs-body) ol{margin:0 0 10px;padding-left:22px}
:is(.card-a,.fs-body) ul{list-style:disc}
:is(.card-a,.fs-body) ul ul{list-style:circle;margin:5px 0 0}
:is(.card-a,.fs-body) ol{list-style:decimal}
:is(.card-a,.fs-body) li{margin:0 0 5px;padding-left:2px}
:is(.card-a,.fs-body) li::marker{color:var(--p)}
:is(.card-a,.fs-body) li.task{list-style:none;margin-left:-20px}
:is(.card-a,.fs-body) li.task.done{opacity:.55;text-decoration:line-through}
:is(.card-a,.fs-body) strong{font-weight:700}
:is(.card-a,.fs-body) del{opacity:.6}
:is(.card-a,.fs-body) a{color:var(--p);text-decoration:underline;text-underline-offset:2px}
:is(.card-a,.fs-body) blockquote{margin:0 0 10px;padding:2px 0 2px 11px;border-left:3px solid var(--p);color:var(--dim)}
:is(.card-a,.fs-body) hr{border:none;border-top:1px solid var(--line);margin:12px 0}
:is(.card-a,.fs-body) table{width:100%;border-collapse:collapse;margin:0 0 10px;display:block;overflow-x:auto;font-size:12.5px}
:is(.card-a,.fs-body) th,:is(.card-a,.fs-body) td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
:is(.card-a,.fs-body) th{background:#ffffff0f;color:var(--dim);font-size:11px;letter-spacing:.04em;text-transform:uppercase;font-weight:650;white-space:nowrap}
pre{background:#00000055;padding:9px 11px;border-radius:8px;overflow-x:auto;font-size:12px;white-space:pre;margin:0 0 10px}
code{font-size:12.5px;background:#00000044;padding:1px 4px;border-radius:4px}
.decision{display:flex;flex-wrap:wrap;gap:6px;margin:10px 14px 0}
.chip{font-size:10px;padding:2px 8px;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--dim)}
.chip.hi{border-color:var(--p);color:#e8a3ae}
.sources{display:flex;flex-direction:column;gap:3px;margin:8px 14px 0}
.source{font-size:11px;color:#8aa0c0;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.notes{margin:10px 14px 0;border-top:1px solid var(--line);padding-top:8px}
.notes-h{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin-bottom:6px}
.note{border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:6px}
.note-t{font-size:11px;margin-bottom:3px}
.note-b{font-size:11px;color:var(--dim);line-height:1.4;margin-bottom:6px}
.fb{display:flex;flex-wrap:wrap;gap:6px;padding:2px 14px 0}
.relbtn{font-size:10px;padding:4px 9px;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:999px;cursor:pointer}
.relbtn:hover{border-color:var(--p)}
.via{padding:6px 14px 10px;font-size:10px;color:var(--dim)}
.empty{text-align:center;padding:56px 20px;color:var(--dim)}
.empty h3{font-size:15px;margin-bottom:6px;color:var(--text)}
.empty p{font-size:12px;line-height:1.8}
.input{padding:10px 12px;background:var(--panel);border-top:1px solid var(--line);display:flex;gap:8px;flex:0 0 auto}
.input input{flex:1;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:9px;color:var(--text);font-size:15px;outline:none}
.input input:focus{border-color:var(--p)}
.input button{padding:12px 18px;background:var(--p);color:#fff;border:none;border-radius:9px;font-size:15px;min-width:70px}
.input button:disabled{opacity:.55}
.input .chip{padding:10px 10px;background:var(--bg);color:var(--dim);border:1px solid var(--line);font-size:11px;min-width:0;max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.selbar{position:fixed;left:10px;right:10px;bottom:78px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 10px;display:none;align-items:center;gap:6px;z-index:40;box-shadow:0 8px 24px #0008}
.selbar.show{display:flex}
.selbar .icon{font-size:11px;padding:6px 8px}
.menu{position:fixed;z-index:60;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;min-width:206px;display:none;box-shadow:0 12px 30px #000a;max-height:80vh;overflow-y:auto}
.menu.show{display:block}
.menu button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-size:13px;padding:10px;border-radius:8px;cursor:pointer}
.menu button:hover{background:var(--card)}
.menu button.danger{color:#ff6b7d}
.menu hr{border:none;border-top:1px solid var(--line);margin:5px 0}
.menu-t{font-size:10px;color:var(--dim);padding:6px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sheet{position:fixed;inset:0;background:#000a;display:none;z-index:70;align-items:flex-end}
.sheet.show{display:flex}
.sheet-body{background:var(--panel);width:100%;max-height:88dvh;overflow-y:auto;border-radius:14px 14px 0 0;padding:16px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.sheet-body h3{font-size:14px;margin-bottom:12px}
.sect{margin-bottom:14px;border-top:1px solid var(--line);padding-top:10px}
.sect h4{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin-bottom:8px}
.row{display:flex;flex-wrap:wrap;gap:6px}
.sect button{background:var(--card);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px}
.modal{position:fixed;inset:0;background:#000b;display:none;z-index:80;align-items:center;justify-content:center;padding:18px}
.modal.show{display:flex}
.modal-box{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;width:100%;max-width:440px;max-height:88dvh;overflow-y:auto;overscroll-behavior:contain}
.modal-box h3{font-size:14px;margin-bottom:6px}
.modal-box p{font-size:11px;color:var(--dim);margin-bottom:8px;line-height:1.5}
.modal-box textarea{width:100%;min-height:72px;max-height:40dvh;overflow-y:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:9px;font-size:13px;font-family:inherit}
.modal-box .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.fs{position:fixed;inset:0;background:var(--bg);z-index:90;display:none;flex-direction:column}
.fs.show{display:flex}
.fs-top{display:flex;justify-content:space-between;padding:12px;border-bottom:1px solid var(--line)}
.fs-body{flex:1;min-height:0;overflow-y:auto;padding:16px;font-size:15px;line-height:1.6;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
#toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(10px);background:#000d;color:#fff;font-size:12px;padding:8px 14px;border-radius:999px;opacity:0;transition:.2s;z-index:100;pointer-events:none;max-width:88vw;text-align:center}
#toast.show{opacity:1;transform:translateX(-50%)}
.why{margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:11px;color:var(--dim);line-height:1.55}
.why-h{text-transform:uppercase;letter-spacing:.08em;font-size:9px;color:var(--p);margin-bottom:4px}
.why-r{padding:2px 0}
.why-r b{color:var(--text);font-weight:600}
.why-ms{opacity:.55}
</style>
</head>
<body>
<div class="top">
  <h1>kards</h1><span class="badge" id="count">0</span><span class="grow"></span>
  <button class="icon" id="selBtn" title="Select">select</button>
  <button class="icon" id="gear" title="Settings">menu</button>
</div>
<div class="cards" id="cards"></div>
<div class="selbar" id="selbar">
  <span id="selCount" style="font-size:12px">0</span><span class="grow"></span>
  <button class="icon" data-sel="merge">Merge</button>
  <button class="icon" data-sel="split">Split</button>
  <button class="icon" data-sel="del">Delete</button>
  <button class="icon" data-sel="clear">Close</button>
</div>
<div class="input"><button class="chip" id="modelBtn" title="Model">auto</button><input id="prompt" placeholder="Type a prompt..." autocomplete="off"><button id="send">Send</button></div>
<div class="menu" id="menu"></div>
<div class="sheet" id="sheet"><div class="sheet-body" id="sheetBody"></div></div>
<div class="modal" id="modal"><div class="modal-box">
  <h3 id="modalTitle">Card</h3><p id="modalDesc"></p><textarea id="modalInput"></textarea>
  <div class="btns"><button class="icon" id="modalNo">Cancel</button><button class="icon on" id="modalGo">Go</button></div>
</div></div>
<div class="fs" id="fs">
  <div class="fs-top"><button class="icon" id="fsClose">back</button><button class="icon" id="fsFlip">flip</button></div>
  <div class="fs-body" id="fsBody"></div>
</div>
<div id="toast"></div>
<script>
var API = { chat: '/chat', feedback: '/feedback', card: '/card', deck: '/deck', prefs: '/prefs' };
var NL = String.fromCharCode(10);
var LS = 'cods:deck:v1';
var S = { cards: [], flip: {}, sel: {}, ctx: null, fs: null, tts: false, light: false, deck: '', cb: null, theme: null, speaking: null, think: false, model: null };
var MK = 'cods:model:v1';
var MODELS = null;
var LP = null;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function stripDangling(s) {
  var t = String(s == null ? '' : s);
  var f = t.lastIndexOf('\`\`\`');
  if (f > -1 && (t.split('\`\`\`').length - 1) % 2 === 1) t = t.slice(0, f);
  var b = t.lastIndexOf('\`');
  if (b > -1 && (t.split('\`').length - 1) % 2 === 1) t = t.slice(0, b);
  t = t.replace(/(^|[\\s(])\\*{1,3}$/, '$1');
  t = t.replace(/(^|[\\s(])_{1,3}$/, '$1');
  return t;
}
function cells(row) {
  var s = row.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  return s.split('|').map(function (c) { return c.trim(); });
}
function mdInline(t) {
  var keep = [];
  var s = esc(String(t == null ? '' : t));
  s = s.replace(/\`([^\`]+)\`/g, function (m, c) {
    keep.push('<code>' + c + '</code>');
    return '\\u0001' + (keep.length - 1) + '\\u0001';
  });
  s = s.replace(/!\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1');
  s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+&quot;[^)]*&quot;)?\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(\\*\\*\\*|___)([^*_]+?)\\1/g, '<strong><em>$2</em></strong>');
  s = s.replace(/(\\*\\*|__)([^*_]+?)\\1/g, '<strong>$2</strong>');
  s = s.replace(/(^|[\\s(])\\*([^*\\s][^*]*?)\\*(?=$|[\\s).,;:!?])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\\s(])_([^_\\s][^_]*?)_(?=$|[\\s).,;:!?])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
  s = s.replace(/\\*{1,3}/g, '');
  s = s.replace(/(^|[\\s(])_{2,3}/g, '$1');
  s = s.replace(/\\u0001(\\d+)\\u0001/g, function (m, i) { return keep[+i] || ''; });
  return s;
}
function md(t) {
  if (t == null) return '';
  var src = String(t).replace(/\\r\\n?/g, '\\n');
  var lines = src.split('\\n');
  var out = [];
  var para = [];
  var stack = [];
  function closeAll() { while (stack.length) out.push('</' + stack.pop().tag + '>'); }
  function flushPara() {
    if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; }
  }
  function block() { flushPara(); closeAll(); }
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    var fence = line.match(/^\\s*(\`\`\`+|~~~+)\\s*([A-Za-z0-9+#._-]*)\\s*$/);
    if (fence) {
      var mark = fence[1];
      var body = [];
      i++;
      while (i < lines.length && lines[i].trim().indexOf(mark) !== 0) { body.push(lines[i]); i++; }
      i++;
      block();
      out.push('<pre><code>' + esc(body.join('\\n')) + '</code></pre>');
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    var h = line.match(/^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$/);
    if (h) {
      block();
      var lv = Math.min(h[1].length + 1, 4);
      out.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>');
      i++;
      continue;
    }
    if (/^\\s{0,3}([-*_])(?:\\s*\\1){2,}\\s*$/.test(line)) { block(); out.push('<hr>'); i++; continue; }
    if (/^\\s{0,3}>/.test(line)) {
      var qb = [];
      while (i < lines.length && /^\\s{0,3}>/.test(lines[i])) {
        qb.push(lines[i].replace(/^\\s{0,3}>\\s?/, ''));
        i++;
      }
      block();
      out.push('<blockquote>' + mdInline(qb.join(' ')) + '</blockquote>');
      continue;
    }
    if (line.indexOf('|') > -1 && i + 1 < lines.length) {
      var sep = lines[i + 1];
      if (sep.indexOf('-') > -1 && sep.replace(/[|\\s:-]/g, '') === '') {
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') > -1 && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
        block();
        var tb = '<table><thead><tr>';
        for (var hi = 0; hi < head.length; hi++) tb += '<th>' + mdInline(head[hi]) + '</th>';
        tb += '</tr></thead><tbody>';
        for (var ri = 0; ri < rows.length; ri++) {
          tb += '<tr>';
          for (var ci = 0; ci < head.length; ci++) tb += '<td>' + mdInline(rows[ri][ci] || '') + '</td>';
          tb += '</tr>';
        }
        out.push(tb + '</tbody></table>');
        continue;
      }
    }
    var li = line.match(/^(\\s*)([-*+]|\\d{1,3}[.)])\\s+(.*)$/);
    if (li) {
      flushPara();
      var indent = li[1].replace(/\\t/g, '  ').length;
      var tag = /\\d/.test(li[2]) ? 'ol' : 'ul';
      while (stack.length && indent < stack[stack.length - 1].indent) out.push('</' + stack.pop().tag + '>');
      var top = stack[stack.length - 1];
      if (!top || indent > top.indent) { stack.push({ tag: tag, indent: indent }); out.push('<' + tag + '>'); }
      else if (top.tag !== tag) { out.push('</' + stack.pop().tag + '>'); stack.push({ tag: tag, indent: indent }); out.push('<' + tag + '>'); }
      var item = li[3];
      var cls = '';
      var task = item.match(/^\\[([ xX])\\]\\s+(.*)$/);
      if (task) {
        cls = task[1] === ' ' ? ' class="task"' : ' class="task done"';
        item = (task[1] === ' ' ? '\\u2610 ' : '\\u2611 ') + task[2];
      }
      out.push('<li' + cls + '>' + mdInline(item) + '</li>');
      i++;
      continue;
    }
    if (stack.length) closeAll();
    para.push(line.trim());
    i++;
  }
  flushPara();
  closeAll();
  return out.join('');
}
/* end-md */
function toast(m) {
  var t = $('toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove('show'); }, 1900);
}
function mk(q, a, provider, extra) {
  var c = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    q: q, a: a, provider: provider || '', decision: null, sources: null, related: null
  };
  if (extra) for (var k in extra) c[k] = extra[k];
  return c;
}
function byId(id) {
  for (var i = 0; i < S.cards.length; i++) if (S.cards[i].id === id) return S.cards[i];
  return null;
}
function picked() { var out = []; S.cards.forEach(function (c) { if (S.sel[c.id]) out.push(c); }); return out; }

var DEFAULT_THEME = { name: 'default', primary: '#c41e3a', bg: '#101014', card: '#1c1c25', text: '#f2f2f6', line: '#2c2c38' };
var PRESETS = {
  default: DEFAULT_THEME,
  light: { name: 'light', primary: '#c41e3a', bg: '#f3f3f7', card: '#ffffff', text: '#15151b', line: '#dcdce6' },
  forest: { name: 'forest', primary: '#4caf7d', bg: '#0e1512', card: '#15201b', text: '#eaf3ee', line: '#243029' },
  ocean: { name: 'ocean', primary: '#3d8bd4', bg: '#0b1017', card: '#121a24', text: '#e8f1fa', line: '#22303d' },
  ember: { name: 'ember', primary: '#e0653a', bg: '#130f0c', card: '#1e1813', text: '#f7efe8', line: '#332a22' },
  mono: { name: 'mono', primary: '#d0d0d8', bg: '#0d0d0f', card: '#17171b', text: '#f4f4f6', line: '#2a2a30' }
};
function cleanTheme(t) {
  if (!t) return null;
  var hex = function (v) { return /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : null; };
  var out = { name: String(t.name || 'custom').slice(0, 24), primary: hex(t.primary), bg: hex(t.bg), card: hex(t.card), text: hex(t.text), line: hex(t.line) || hex(t.card) };
  if (!out.primary || !out.bg || !out.card || !out.text) return null;
  return out;
}
function applyTheme(t) {
  var c = cleanTheme(t);
  if (!c) return;
  S.theme = c;
  var s = document.documentElement.style;
  s.setProperty('--p', c.primary);
  s.setProperty('--bg', c.bg);
  s.setProperty('--card', c.card);
  s.setProperty('--panel', c.card);
  s.setProperty('--text', c.text);
  s.setProperty('--line', c.line);
  document.body.classList.remove('light');
}

function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({ cards: S.cards.slice(0, 80), tts: S.tts, light: S.light, deck: S.deck, theme: S.theme, think: S.think }));
  } catch (e) {}
  queueDeck();
}
var deckT = null;
function queueDeck() {
  clearTimeout(deckT);
  deckT = setTimeout(function () {
    if (!S.deck) return;
    fetch(API.deck + '?id=' + encodeURIComponent(S.deck), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards: S.cards.slice(0, 80).map(function (c) { return { q: c.q, a: c.a }; }), theme: S.theme })
    }).catch(function () {});
  }, 1200);
}

function meta(c) {
  var html = '';
  var d = c.decision, tags = [];
  if (d) {
    if (d.intent) tags.push('intent: ' + d.intent);
    if (d.domain) tags.push('domain: ' + d.domain);
    if (d.depth != null) tags.push('depth: ' + d.depth);
    if (d.tone) tags.push('tone: ' + d.tone);
    if (d.needs_web != null) tags.push('web: ' + (d.needs_web >= 0.5 ? 'yes' : 'no'));
    if (d.sensitive != null && d.sensitive >= 0.5) tags.push('care');
  }
  if (tags.length) {
    html += '<div class="decision">' + tags.map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div>';
  }
  if (c.sources && c.sources.length) {
    html += '<div class="sources">' + c.sources.map(function (s, i) {
      return '<a class="source" href="' + esc(s.url) + '" target="_blank" rel="noopener">[' + (i + 1) + '] ' + esc(s.title) + '</a>';
    }).join('') + '</div>';
  }
  return html;
}
function notes(c) {
  if (!c.related || !c.related.length) return '';
  return '<div class="notes"><div class="notes-h">Already in the notes</div>' + c.related.map(function (n, i) {
    return '<div class="note"><div class="note-t">' + esc(n.title) + '</div>' +
      '<div class="note-b">' + esc(String(n.text || '').slice(0, 220)) + '</div>' +
      '<button class="relbtn" data-act="combine" data-card="' + esc(c.id) + '" data-note="' + i + '">Combine</button> ' +
      '<button class="relbtn" data-act="extract" data-card="' + esc(c.id) + '" data-note="' + i + '">Extract</button></div>';
  }).join('') + '</div>';
}
function fb(c) {
  var id = esc(c.id);
  return '<div class="fb">' +
    '<button class="relbtn" data-act="fb" data-fb="more" data-card="' + id + '">More like this</button>' +
    '<button class="relbtn" data-act="fb" data-fb="deeper" data-card="' + id + '">Go deeper</button>' +
    '<button class="relbtn" data-act="fb" data-fb="again" data-card="' + id + '">Search again</button>' +
    '<button class="relbtn" data-act="fb" data-fb="wrong" data-card="' + id + '">Wrong</button>' +
    '</div>';
}
var reduceMotion = false;
try { reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}

function stopVoice() {
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) {}
  if (S.speaking) {
    var old = S.speaking;
    S.speaking = null;
    var b = document.querySelector('[data-tts="' + old + '"]');
    if (b) b.textContent = 'play';
  }
}
function speak(c) {
  if (!c) return;
  if (!('speechSynthesis' in window)) { toast('No voice here'); return; }
  if (S.speaking === c.id) { stopVoice(); toast('Stopped'); return; }
  stopVoice();
  var text = String(c.a || '').replace(/\\s+/g, ' ').trim();
  if (!text) return;
  var u = new SpeechSynthesisUtterance(text);
  S.speaking = c.id;
  var b = document.querySelector('[data-tts="' + c.id + '"]');
  if (b) b.textContent = 'stop';
  u.onend = u.onerror = function () { if (S.speaking === c.id) stopVoice(); };
  window.speechSynthesis.speak(u);
}

function why(c) {
  if (!S.think || !c.thinking || !c.thinking.length) return '';
  return '<div class="why"><div class="why-h">how it got here</div>' + c.thinking.map(function (s) {
    return '<div class="why-r"><b>' + esc(s.step) + '</b> ' + esc(s.detail || '') +
      (s.ms != null ? ' <span class="why-ms">' + s.ms + 'ms</span>' : '') + '</div>';
  }).join('') + '</div>';
}

function readStream(res, onStep) {
  var done = null;
  if (!res.body || !res.body.getReader) {
    return res.text().then(function (t) { return { status: res.status, text: t, json: null }; });
  }
  var reader = res.body.getReader();
  var dec = new TextDecoder();
  var buf = '';
  return (function pump() {
    return reader.read().then(function (r) {
      if (r.done) {
        if (done) return { status: 200, json: done };
        return { status: res.status, text: buf, json: null };
      }
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split('\\n');
      buf = lines.pop();
      lines.forEach(function (line) {
        line = line.trim();
        if (!line) return;
        var ev = null;
        try { ev = JSON.parse(line); } catch (e) { return; }
        if (ev.type === 'step') { if (onStep) onStep(ev); }
        else if (ev.type === 'done') done = ev.payload;
        else if (ev.type === 'error') done = { error: ev.error };
      });
      return pump();
    });
  })();
}

function typeIn(c) {
  if (reduceMotion) return;
  var node = document.querySelector('.card[data-id="' + c.id + '"] .card-a');
  if (!node) return;
  var text = String(c.a || '');
  if (text.length < 40) return;
  var i = 0;
  node.textContent = '';
  var timer = setInterval(function () {
    if (!node.isConnected) { clearInterval(timer); return; }
    i += 9;
    node.innerHTML = md(stripDangling(text.slice(0, i)));
    if (i >= text.length) { clearInterval(timer); node.innerHTML = md(c.a); }
  }, 18);
}

function cardHTML(c) {
  var id = esc(c.id);
  var flipped = S.flip[c.id] ? ' flipped' : '';
  var sel = S.sel[c.id] ? ' sel' : '';
  return '<div class="card' + flipped + sel + '" data-id="' + id + '">' +
    '<div class="face front"><div class="fh"><span class="lab">req</span>' +
      '<span class="acts"><span class="dots" data-dots="' + id + '">more</span></span></div>' +
      '<div class="body card-q">' + esc(c.q) + '</div></div>' +
    '<div class="face back"><div class="fh"><span class="lab">answer</span><span class="acts">' +
      '<span class="dots" data-tts="' + id + '">' + (S.speaking === c.id ? 'stop' : 'play') + '</span><span class="dots" data-dots="' + id + '">more</span></span></div>' +
      '<div class="body card-a">' + md(c.a) + '</div>' + meta(c) + why(c) + notes(c) + fb(c) + '</div>' +
    '<div class="via">via ' + esc(c.provider) + '</div></div>';
}
function render() {
  $('count').textContent = String(S.cards.length);
  var box = $('cards');
  if (!S.cards.length) {
    box.innerHTML = '<div class="empty"><h3>No cards yet</h3><p>Type below to start.<br>Tap a card to flip it. Long press for the menu.</p></div>';
    updSel();
    return;
  }
  box.innerHTML = S.cards.map(cardHTML).join('');
  updSel();
}
function scrollBottom() { var b = $('cards'); b.scrollTop = b.scrollHeight; }

function openMenu(id, x, y) {
  var c = byId(id);
  if (!c) return;
  S.ctx = id;
  var n = picked().length;
  var h = '<div class="menu-t">' + esc(String(c.q || '').slice(0, 54)) + '</div>' +
    '<button data-op="continue">Continue / refine</button>' +
    '<button data-op="magic">Magic rewrite</button>' +
    '<button data-op="style">Style</button>' +
    '<button data-op="split">Split into cards</button>' +
    '<button data-op="merge">Merge' + (n > 1 ? ' (' + n + ')' : '') + '</button>' +
    '<button data-op="speak">' + (S.speaking === c.id ? 'Stop reading' : 'Read aloud') + '</button>' +
    '<button data-op="approve">Approve this answer</button>' +
    '<button data-op="unapprove">Unapprove</button>' +
    '<hr>' +
    '<button data-op="sel">' + (S.sel[id] ? 'Deselect' : 'Select') + '</button>' +
    '<button data-op="copy">Copy</button>' +
    '<button data-op="full">Fullscreen</button>' +
    '<hr>' +
    '<button class="danger" data-op="del">Delete</button>';
  var m = $('menu');
  m.innerHTML = h;
  m.classList.add('show');
  var w = m.offsetWidth || 210, ht = m.offsetHeight || 330;
  m.style.left = Math.max(8, Math.min(x || 14, window.innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y || 90, window.innerHeight - ht - 8)) + 'px';
}
function closeMenu() { $('menu').classList.remove('show'); S.ctx = null; }

function ask(title, desc, ph, cb) {
  $('modalTitle').textContent = title;
  $('modalDesc').textContent = desc;
  $('modalInput').value = '';
  $('modalInput').placeholder = ph || '';
  S.cb = cb;
  $('modal').classList.add('show');
  setTimeout(function () { $('modalInput').focus(); }, 60);
}

function act(name) {
  var c = byId(S.ctx);
  closeMenu();
  if (name === 'merge') {
    var p = picked();
    if (p.length < 2) { toast('Select two cards first'); return; }
    ask('Merge cards', 'Combine the selected cards into one.', 'optional: how to combine', function (v) { run('merge', p, v); });
    return;
  }
  if (name === 'speak') { speak(c); return; }
  if (name === 'approve' || name === 'unapprove') { approveCard(c, name === 'unapprove' ? 0 : 3); return; }
  if (name === 'sel') { if (c) { if (S.sel[c.id]) delete S.sel[c.id]; else S.sel[c.id] = true; render(); } return; }
  if (!c) return;
  if (name === 'copy') {
    var text = String(c.q || '') + NL + NL + String(c.a || '');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, function () { toast('Copy failed'); });
    else toast('Copy unavailable');
    return;
  }
  if (name === 'full') { openFs(c); return; }
  if (name === 'del') { del(c.id); return; }
  if (name === 'split') { ask('Split card', 'Break this card into separate cards. The decision model still picks the domain.', 'optional: how to split', function (v) { run('split', [c], v); }); return; }
  if (name === 'continue') { ask('Continue', 'Extend this card with the next step.', 'optional: what to continue', function (v) { run('continue', [c], v); }); return; }
  if (name === 'style') { ask('Style', 'Rewrite the card in a style.', 'e.g. bullets, plain, tighter', function (v) { run('style', [c], v || 'bullets'); }); return; }
  if (name === 'magic') { run('magic', [c], 'tighter and clearer'); return; }
}

function run(kind, list, instruction) {
  var payload = { op: kind };
  if (kind === 'merge') payload.cards = list.map(function (c) { return { q: c.q, a: c.a }; });
  else payload.card = { q: list[0].q, a: list[0].a, prompt: list[0].prompt };
  if (instruction) payload.instruction = instruction;
  toast(kind);
  fetch(API.card, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || d.error) { toast('Error: ' + ((d && d.error) || 'no reply')); return; }
      var got = d.cards || [];
      if (!got.length) { toast('Nothing came back'); return; }
      if (kind === 'merge') {
        var at = Math.max(0, S.cards.indexOf(list[0]));
        S.cards = S.cards.filter(function (c) { return list.indexOf(c) < 0; });
        S.cards.splice(Math.min(at, S.cards.length), 0, mk(got[0].q || 'Merged', got[0].a, d.provider, { decision: d.decision }));
        S.sel = {};
      } else if (kind === 'split') {
        var i = S.cards.indexOf(list[0]);
        S.cards.splice(i, 1, mk(got[0].q, got[0].a, d.provider, { decision: d.decision }));
        for (var n = 1; n < got.length; n++) S.cards.splice(i + n, 0, mk(got[n].q, got[n].a, d.provider, { decision: d.decision }));
      } else {
        var c = list[0];
        c.a = got[0].a;
        c.provider = d.provider || c.provider;
        S.flip[c.id] = true;
      }
      render(); save(); toast(kind + ' done');
    })
    .catch(function (e) { toast('Failed: ' + (e && e.message ? e.message : e)); });
}

function approveCard(c, rank) {
  if (!c) return;
  var q = c.prompt || c.q;
  fetch('/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: q, rank: rank, cards: [{ q: q, a: c.a }] })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.error) return toast(d.error);
    toast(rank === 0 ? 'Approval removed' : 'Approved: same question, same cards');
  }).catch(function () { toast('Approval failed'); });
}

function del(id) {
  if (S.speaking === id) stopVoice();
  S.cards = S.cards.filter(function (c) { return c.id !== id; });
  delete S.sel[id];
  delete S.flip[id];
  if (S.fs === id) closeFs();
  render(); save();
}
function updSel() {
  var n = picked().length;
  $('selCount').textContent = String(n);
  $('selbar').classList.toggle('show', n > 0);
}
function clearSel() { S.sel = {}; render(); }

function openFs(c) {
  S.fs = c.id;
  $('fsBody').innerHTML = '<div class="card-q" style="color:var(--dim);font-size:13px;margin-bottom:10px">' + esc(c.q) + '</div>' + md(c.a);
  $('fs').classList.add('show');
}
function closeFs() { $('fs').classList.remove('show'); S.fs = null; }

function sendPrompt(p, extra) {
  var input = $('prompt'), btn = $('send');
  if (!p) {
    p = input.value.trim();
    if (!p) return;
  }
  input.value = '';
  btn.disabled = true;
  btn.textContent = '...';
  stopVoice();
  var ctx = S.cards.filter(function (c) { return c.provider !== 'working'; })
    .map(function (c) { return { q: c.q, r: c.a }; }).slice(-12);
  var pending = mk(p, 'Thinking...', 'working');
  pending.prompt = p;
  pending.thinking = [];
  S.cards.push(pending);
  S.flip[pending.id] = true;
  var pid = pending.id, fresh = [];
  render(); scrollBottom();

  var ask = Object.assign(askBody(p, ctx), extra || {});
  function onStep(ev) {
    var cur = byId(pid);
    if (!cur) return;
    cur.thinking.push({ step: ev.step, detail: ev.detail, ms: ev.ms });
    cur.a = cur.thinking.map(function (s) { return s.step + ' — ' + (s.detail || ''); }).join(NL);
    render(); scrollBottom();
  }

  fetch(API.chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ask)
  })
    .then(function (r) { return readStream(r, onStep); })
    .then(function (res) {
      var d = res && res.json ? res.json : null;
      if (!d && res && res.text) { try { d = JSON.parse(res.text); } catch (e) { d = null; } }
      var cur = byId(pid);
      if (!d) {
        if (cur) {
          cur.a = 'Server returned ' + ((res && res.status) || '?') + ': ' + String((res && res.text) || '').slice(0, 300);
          cur.provider = 'error';
        }
        return;
      }
      if (d.error) {
        if (cur) { cur.a = d.error; cur.provider = 'error'; cur.decision = d.decision || null; }
        return;
      }
      if (d.clarify) {
        if (cur) {
          cur.a = d.clarify.questions.map(function (q) { return '• ' + q.q; }).join(NL);
          cur.provider = 'decision model · needs a word from you';
          cur.decision = d.decision || null;
          cur.ask = d.clarify;
          S.flip[cur.id] = true;
        }
        render(); scrollBottom();
        showClarify(p, d.clarify);
        return;
      }
      if (d.theme) { applyTheme(d.theme); save(); toast('Theme: ' + d.theme.name); }
      var got = d.cards && d.cards.length ? d.cards : null;
      if (got && got.length > 1) {
        var at = S.cards.indexOf(cur);
        if (at < 0) at = S.cards.length;
        S.cards.splice(at, 1);
        got.forEach(function (g, i) {
          var title = p + (g.kind ? ' · ' + g.kind : '') + (g.source && g.source.title ? ' — ' + g.source.title : '');
          var card = mk(title, g.a, (g.provider || d.provider || '') + (d.route ? ' · ' + d.route : ''), {
            prompt: p, decision: d.decision || null, thinking: d.thinking || null,
            sources: g.source ? [g.source] : (d.sources || null), related: d.related || null
          });
          S.cards.splice(at + i, 0, card);
          fresh.push(card);
        });
      } else if (cur) {
        cur.a = d.answer || d.response || '(no response)';
        cur.provider = d.approved
          ? 'approved · rank ' + d.rank
          : (d.provider || 'openrouter') + (d.route ? ' · ' + d.route : '') +
            (d.pick && d.pick.error ? ' · ' + d.pick.requested + ' failed' : '');
        cur.decision = d.decision || null;
        cur.thinking = d.thinking || null;
        cur.sources = d.sources || null;
        cur.related = d.related || null;
        S.flip[cur.id] = true;
        fresh.push(cur);
      }
      render();
      fresh.forEach(function (c) { if (S.flip[c.id]) typeIn(c); });
    })
    .catch(function (e) {
      var cur = byId(pid);
      if (cur) { cur.a = 'Network error: ' + (e && e.message ? e.message : e); cur.provider = 'error'; }
    })
    .then(function () {
      btn.disabled = false;
      btn.textContent = 'Send';
      if (!fresh.length) render();
      save();
      scrollBottom();
    });
}

// The pick travels with the question. Workers AI models are named directly;
// a proxy pick rides the binding with its preset.
function askBody(p, ctx) {
  var b = { prompt: p, cards: ctx, stream: true };
  var m = S.model;
  if (!m) return b;
  if (m.openrouter) { b.model = m.preset ? 'preset:' + m.preset : 'openrouter:' + m.model; return b; }
  if (m.proxy) { b.proxy = true; if (m.preset) b.preset = m.preset; }
  else if (m.cf) { b.model = m.cf; b.cf_models = [m.cf]; }
  return b;
}

// The decision layer asked something. Ask the questions one at a time, take
// the typed answer or the suggested option, then send it all back with the
// original question so the decision is made on real intent.
var CLARIFY = null;

function showClarify(prompt, c) {
  CLARIFY = { prompt: prompt, round: c.round || 0, queue: (c.questions || []).slice(), asked: (c.said || []).slice() };
  nextClarify();
}

function nextClarify() {
  if (!CLARIFY) return;
  if (!CLARIFY.queue.length) {
    var job = CLARIFY;
    CLARIFY = null;
    var extra = { clarify: job.asked };
    var web = job.asked.filter(function (x) { return x.id === 'web'; })[0];
    if (web) extra.search = /search|web|look/i.test(String(web.a)) ? 'yes' : 'no';
    return sendPrompt(job.prompt, extra);
  }
  var q = CLARIFY.queue[0];
  $('modalTitle').textContent = q.q;
  $('modalDesc').textContent = q.options && q.options.length ? 'Tap one, or type your own answer.' : 'Type your answer.';
  $('modalInput').value = '';
  $('modalInput').placeholder = (q.options && q.options[0]) || 'your answer';
  $('modal').classList.add('show');
  var go = function (ev) {
    if (!CLARIFY) return;
    if (ev) ev.preventDefault();
    var v = $('modalInput').value.trim() || (q.options && q.options[0]) || '';
    CLARIFY.asked.push({ id: q.id, q: q.q, a: v });
    CLARIFY.queue.shift();
    $('modal').classList.remove('show');
    nextClarify();
  };
  $('modalGo').onclick = go;
  if (q.options && q.options.length) {
    Array.prototype.forEach.call($('modalDesc').parentNode.querySelectorAll('[data-clar]'), function (n) { n.remove(); });
    var box = document.createElement('div');
    box.className = 'row';
    box.style.marginBottom = '8px';
    q.options.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'icon';
      b.setAttribute('data-clar', '1');
      b.textContent = o;
      b.onclick = function () { $('modalInput').value = o; go(); };
      box.appendChild(b);
    });
    $('modalDesc').parentNode.insertBefore(box, $('modalInput'));
  }
}

function paintModel() {
  var b = $('modelBtn');
  if (b) b.textContent = S.model && S.model.label ? S.model.label : 'auto';
}

function keepModel(m) {
  S.model = m;
  try { localStorage.setItem(MK, JSON.stringify(m)); } catch (e) {}
  try { if (window.speechSynthesis) stopVoice(); } catch (e) {}
  paintModel();
  $('sheet').classList.remove('show');
  toast('Model: ' + ((m && m.label) || 'auto'));
  fetch(API.feedback, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'model', model: (m && m.store) || '', q: 'model picker' })
  }).catch(function () {});
}

function openModels() {
  $('sheetBody').innerHTML = '<h3>Model</h3>' +
    '<p style="font-size:11px;color:var(--dim);margin:0 0 8px;line-height:1.5">Auto lets the decision model choose. Whatever you pick here is remembered and used for the next questions.</p>' +
    '<div id="modelList">loading...</div>';
  $('sheet').classList.add('show');
  fetch('/models').then(function (r) { return r.json(); }).then(function (d) {
    MODELS = d;
    var out = '<div class="row"><button data-pick="0">auto — decision model</button></div>';
    out += '<div class="sect"><h4>Cloudflare</h4><div class="row">';
    (d.workers || []).forEach(function (m, i) { out += '<button data-pick="' + (i + 1) + '">' + esc(m.label) + '</button>'; });
    out += '</div></div>';
    if (d.openrouter && d.openrouter.bound) {
      out += '<div class="sect"><h4>OpenRouter' + (d.openrouter.via === 'proxy' ? ' · via proxy' : '') + '</h4><div class="row">';
      (d.openrouter.models || []).forEach(function (m, i) { out += '<button data-pick="o:' + i + '">' + esc(m.short || m.id) + '</button>'; });
      (d.openrouter.presets || []).forEach(function (p) { out += '<button data-pick="p:' + esc(p) + '">preset · ' + esc(p) + '</button>'; });
      out += '<button data-pick="x">type a model or preset…</button></div></div>';
    }
    var el = $('modelList');
    if (el) el.innerHTML = out;
  }).catch(function (e) {
    var el = $('modelList');
    if (el) el.textContent = 'Could not load models: ' + ((e && e.message) || e);
  });
}

document.addEventListener('click', function (e) {
  var b = e.target && e.target.closest ? e.target.closest('[data-pick]') : null;
  if (!b) return;
  var v = b.getAttribute('data-pick') || '';
  e.preventDefault();
  if (v === '0') return keepModel(null);
  if (v === 'x') {
    var typed = (window.prompt('Model id, or a preset name', 'openai/gpt-4o-mini') || '').trim();
    if (!typed) return;
    if (typed.charAt(0) === '@' || typed.indexOf('/') > 0) {
      return keepModel({ label: typed, store: 'openrouter:' + typed, openrouter: true, model: typed });
    }
    return keepModel({ label: 'preset · ' + typed, store: 'preset:' + typed, openrouter: true, preset: typed });
  }
  if (v.indexOf('o:') === 0) {
    var om = ((MODELS && MODELS.openrouter && MODELS.openrouter.models) || [])[Number(v.slice(2))];
    if (!om) return;
    return keepModel({ label: om.short || om.id, store: 'openrouter:' + om.id, openrouter: true, model: om.id });
  }
  if (v.indexOf('p:') === 0) {
    var pslug = v.slice(2);
    if (!pslug) return;
    return keepModel({ label: 'preset · ' + pslug, store: 'preset:' + pslug, openrouter: true, preset: pslug });
  }
  var m = (MODELS.workers || [])[Number(v) - 1];
  if (!m) return;
  return keepModel({ label: m.short || m.label, store: m.id, cf: m.id });
});

function feedback(c, act) {
  if (!c) return;
  fetch(API.feedback, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: act, q: c.prompt || c.q, a: c.a, decision: c.decision || null })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.learned) toast('Noted: ' + String(d.learned).slice(0, 90));
  }).catch(function () {});
  if (act === 'more') sendPrompt('Give me three other angles on this, as separate cards: ' + c.q);
  else if (act === 'deeper') sendPrompt('Go deeper on this and show the reasoning: ' + c.q);
  else if (act === 'again') sendPrompt(c.q + ' — search the web again and give me the freshest sources');
  else sendPrompt('That card was wrong or off target:' + NL + String(c.a || '').slice(0, 400) + NL + NL + 'Answer it properly instead: ' + c.q);
}

$('modelBtn').onclick = function () { openModels(); };

function openSheet() {
  $('sheetBody').innerHTML =
    '<h3>Settings</h3>' +
    '<div class="sect"><h4>Data</h4><div class="row">' +
      '<button data-set="export">Export cards</button>' +
      '<button data-set="import">Import cards</button>' +
      '<button data-set="clear">Clear all cards</button>' +
      '<button data-set="newdeck">New deck</button>' +
    '</div><p style="font-size:11px;color:var(--dim);margin-top:8px;line-height:1.5">Deck ' + esc(S.deck) + ' is saved in KV, so the cards come back on another phone.</p></div>' +
    '<div class="sect"><h4>View</h4><div class="row">' +
      Object.keys(PRESETS).map(function (k) { return '<button data-set="preset" data-name="' + k + '">' + k + '</button>'; }).join('') +
      '<button data-set="tts">Voice ' + (S.tts ? 'on' : 'off') + '</button>' +
      '<button data-set="think">Thought process ' + (S.think ? 'on' : 'off') + '</button>' +
    '</div></div>' +
    '<div class="sect"><h4>What it learned</h4><p id="prefText" style="font-size:12px;color:var(--dim);line-height:1.5">loading...</p>' +
      '<div class="row" style="margin-top:8px"><button data-set="prefs">Refresh</button><button data-set="forget">Forget it</button></div></div>' +
    '<div class="sect"><h4>Approved answers</h4><p id="apprText" style="font-size:12px;color:var(--dim);line-height:1.5">loading...</p>' +
      '<div class="row" style="margin-top:8px"><button data-set="approved">Refresh</button></div></div>' +
    '<div class="sect"><h4>API</h4><p style="font-size:11px;color:var(--dim);line-height:1.6">' + esc(location.origin) + '/chat · /card · /deck · /prefs</p></div>';
  $('sheet').classList.add('show');
  loadPrefs();
  loadApprovedList();
}
function loadPrefs() {
  fetch(API.prefs).then(function (r) { return r.json(); }).then(function (d) {
    var p = $('prefText');
    if (!p) return;
    p.textContent = d && d.hint ? d.hint : 'Nothing yet. Press a card button and it starts learning.';
  }).catch(function () {});
}
function loadApprovedList() {
  fetch('/approved').then(function (r) { return r.json(); }).then(function (d) {
    var p = document.getElementById('apprText');
    if (!p) return;
    if (!d || !d.count) { p.textContent = 'Nothing approved yet. Approve a card and that question always returns it.'; return; }
    p.textContent = d.count + ' approved: ' + d.items.slice(0, 3).map(function (i) { return i.q + ' (rank ' + i.rank + ')'; }).join(' · ');
  }).catch(function () {});
}

function exportCards() {
  var blob = new Blob([JSON.stringify({ cards: S.cards }, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'kards.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  toast('Exported ' + S.cards.length + ' cards');
}
function importCards() {
  var picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.json,application/json';
  picker.onchange = function () {
    var f = picker.files && picker.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var d = JSON.parse(String(rd.result));
        var arr = Array.isArray(d) ? d : d.cards;
        if (!Array.isArray(arr)) throw new Error('no cards');
        S.cards = arr.map(function (c) { return mk(c.q || c.question || '', c.a || c.r || c.response || '', 'imported'); });
        render(); save();
        toast('Imported ' + S.cards.length);
      } catch (e) { toast('Invalid JSON'); }
    };
    rd.readAsText(f);
  };
  picker.click();
}

$('cards').addEventListener('click', function (e) {
  var t = e.target;
  var dots = t.closest('[data-dots]');
  if (dots) { e.stopPropagation(); openMenu(dots.getAttribute('data-dots'), e.clientX, e.clientY); return; }
  var spk = t.closest('[data-tts]');
  if (spk) {
    e.stopPropagation();
    speak(byId(spk.getAttribute('data-tts')));
    return;
  }
  var b = t.closest('.relbtn');
  if (b) {
    e.stopPropagation();
    var id = b.getAttribute('data-card');
    if (b.getAttribute('data-act') === 'fb') { feedback(byId(id), b.getAttribute('data-fb')); return; }
    var c = byId(id), n = c && c.related && c.related[Number(b.getAttribute('data-note'))];
    if (!c || !n) return;
    var head = b.getAttribute('data-act') === 'combine'
      ? 'Combine this saved note with my card and answer with the merged version.'
      : 'Extract from this saved note only what answers my card.';
    sendPrompt(head + NL + NL + 'My card:' + NL + c.q + NL + (c.a || '') + NL + NL + 'Saved note:' + NL + n.title + NL + n.text);
    return;
  }
  var card = t.closest('.card');
  if (!card) return;
  var cid = card.getAttribute('data-id');
  if (S.sel[cid]) { delete S.sel[cid]; render(); return; }
  S.flip[cid] = !S.flip[cid];
  render();
});
$('cards').addEventListener('touchstart', function (e) {
  var card = e.target.closest('.card');
  if (!card) return;
  var touch = e.touches && e.touches[0] ? e.touches[0] : e;
  clearTimeout(LP);
  LP = setTimeout(function () {
    if (navigator.vibrate) navigator.vibrate(30);
    openMenu(card.getAttribute('data-id'), touch.clientX, touch.clientY);
  }, 450);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(function (ev) {
  $('cards').addEventListener(ev, function () { clearTimeout(LP); }, { passive: true });
});
$('menu').addEventListener('click', function (e) {
  var b = e.target.closest('[data-op]');
  if (!b) return;
  act(b.getAttribute('data-op'));
});
document.addEventListener('click', function (e) {
  if (!e.target.closest('#menu') && !e.target.closest('[data-dots]')) closeMenu();
});
$('selbar').addEventListener('click', function (e) {
  var b = e.target.closest('[data-sel]');
  if (!b) return;
  var what = b.getAttribute('data-sel');
  if (what === 'clear') return clearSel();
  if (what === 'del') { picked().forEach(function (c) { del(c.id); }); S.sel = {}; render(); save(); return; }
  if (what === 'merge') {
    var p = picked();
    if (p.length < 2) return toast('Pick two or more');
    ask('Merge cards', 'Combine the selected cards into one.', 'optional instruction', function (v) { run('merge', p, v); });
    return;
  }
  if (what === 'split') { var c = picked()[0]; if (!c) return; ask('Split card', 'Break this card into separate cards.', 'optional instruction', function (v) { run('split', [c], v); }); }
});
$('modalNo').onclick = function () { $('modal').classList.remove('show'); S.cb = null; };
$('modalGo').onclick = function () {
  var v = $('modalInput').value.trim();
  var cb = S.cb;
  $('modal').classList.remove('show');
  S.cb = null;
  if (cb) cb(v);
};
$('selBtn').onclick = function () {
  var c = S.cards[S.cards.length - 1];
  if (!c) return toast('No cards yet');
  openMenu(c.id, window.innerWidth / 2 - 100, 120);
};
$('gear').onclick = openSheet;
$('sheet').addEventListener('click', function (e) {
  if (e.target === $('sheet')) $('sheet').classList.remove('show');
  var b = e.target.closest('[data-set]');
  if (!b) return;
  var w = b.getAttribute('data-set');
  if (w === 'export') return exportCards();
  if (w === 'import') return importCards();
  if (w === 'clear') { if (!window.confirm('Clear all cards?')) return; stopVoice(); S.cards = []; S.sel = {}; S.flip = {}; render(); save(); toast('Cleared'); return; }
  if (w === 'newdeck') { S.cards = []; S.sel = {}; S.flip = {}; S.deck = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); render(); save(); toast('New deck'); return; }
  if (w === 'preset') { applyTheme(PRESETS[b.getAttribute('data-name')] || PRESETS.default); save(); openSheet(); return; }
  if (w === 'approved') return loadApprovedList();
  if (w === 'tts') { S.tts = !S.tts; if (!S.tts) stopVoice(); save(); openSheet(); return; }
  if (w === 'think') { S.think = !S.think; save(); render(); openSheet(); return; }
  if (w === 'prefs') return loadPrefs();
  if (w === 'forget') {
    fetch(API.prefs, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) })
      .then(function () { toast('Forgotten'); loadPrefs(); }).catch(function () {});
  }
});
$('fsClose').onclick = closeFs;
$('fsFlip').onclick = function () {
  var c = byId(S.fs);
  if (!c) return;
  S.flip[c.id] = !S.flip[c.id];
  $('fsBody').innerHTML = '<div class="card-q" style="color:var(--dim);font-size:13px;margin-bottom:10px">' + esc(c.q) + '</div>' + md(c.a);
};
$('send').onclick = function () { sendPrompt(null); };
$('prompt').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendPrompt(null); } });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeMenu(); closeFs(); $('modal').classList.remove('show'); $('sheet').classList.remove('show'); }
});

(function boot() {
  var had = false;
  try {
    var d = JSON.parse(localStorage.getItem(LS) || 'null');
    try { var picked = JSON.parse(localStorage.getItem(MK) || 'null'); if (picked) S.model = picked; } catch (e) {}
    paintModel();
    if (d && Array.isArray(d.cards)) {
      S.cards = d.cards;
      S.tts = !!d.tts;
      S.light = !!d.light;
      S.deck = d.deck || '';
      S.theme = d.theme || null;
      S.think = !!d.think;
      had = S.cards.length > 0;
    }
  } catch (e) {}
  if (!S.deck) S.deck = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (S.theme) applyTheme(S.theme);
  render();
  if (!had) {
    fetch(API.deck + '?id=' + encodeURIComponent(S.deck)).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.theme && !S.theme) applyTheme(d.theme);
      if (d && d.cards && d.cards.length && !S.cards.length) {
        S.cards = d.cards.map(function (c) { return mk(c.q, c.a, 'kv'); });
        render();
      }
    }).catch(function () {});
  }
})();
</script>
</body>
</html>`;

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
        websearch: !!(env.AI && typeof env.AI.websearch === "function"),
        search_provider: env.SEARCH_PROVIDER || "ceramic",
        search_url: env.SEARCH_URL ? "configured" : null,
        browser: !!env.BROWSER,
        ocode: !!env.OCODE,
        orproxy: !!env.ORPROXY,
        orproxy_mode: orProxyMode,
        orproxy_preset: env.ORPROXY_PRESET || OR_PROXY_PRESET,
        search_chain: (env.OCODE ? ["harness"] : [])
          .concat(env.SEARCH_URL ? ["search-url"] : [])
          .concat(env.BROWSER ? ["browser"] : [])
          .concat(["cloudflare"])
          .concat(String(env.SEARCH_BING || "") === "1" ? ["bing"] : [])
          .concat(["duckduckgo", "github", "wikipedia"]),
        github_token: !!env.GITHUB_TOKEN,
        gateway: env.AI_GATEWAY_ID || "default",
        ai_search: aiSearchBase(env),
        ai_search_instance: env.AI_SEARCH_INSTANCE || AI_SEARCH_INSTANCE,
        index_writer: indexHandle(env) ? "binding" : env.CF_ACCOUNT_ID && env.AI_SEARCH_TOKEN ? "rest" : "none",
        text_models: CF_TEXT_MODELS,
        clef_context: CLEF_CONTEXT_TOKENS,
        card_limit: CARD_LIMIT,
        card_ops: Object.keys(CARD_OPS),
        approved: !!arcStore(env),
        admin: !!env.ADMIN,
        memory: { context: !!env.CONTEXT, archive: !!env.ARCHIVE, cache: !!env.CACHE, kv: !!env.KV, ltm: !!env.LTM, shapes: !!env.LTM, loader: !!env.LOADER },
        stream: "ndjson",
        themes: Object.keys(THEMES),
        openrouter: !!env.OPENROUTER_API_KEY,
        truth_store: env.TRUTHS ? "TRUTHS" : env.ARCHIVE ? "ARCHIVE" : env.KV ? "KV" : null,
        truth_key: !!env.TRUTH_KEY,
        chat_model: env.CF_CHAT_MODEL || null,
        kv: !!env.KV,
        prefs: !!ctxStore(env),
        domains: Object.keys(DOMAINS),
      });
    }

    // POST nothing: this asks the proxy one tiny question and reports which way
  // in it accepted, or every error it gave, so the binding can be checked from
  // a phone browser instead of a terminal.
  if (url.pathname === "/orproxy") {
    if (!env.ORPROXY) return json({ ok: false, error: "ORPROXY is not bound on this Worker" }, 400);
    try {
      const wanted = url.searchParams.get("preset") || url.searchParams.get("model") || "";
      const hit = await orProxyCall(
        env,
        [{ role: "user", content: "Reply with exactly: ready" }],
        { max_tokens: 120, temperature: 0, proxy: true, preset: wanted || undefined }
      );
      return json({ ok: true, via: hit.via, model: hit.model, reply: hit.text.slice(0, 200) });
    } catch (err) {
      return json({ ok: false, mode: orProxyMode, notes: err.notes || [err.message] }, 502);
    }
  }

  // The picker's list: what can answer, what the proxy offers, and what this
  // person chose last time.
  if (url.pathname === "/models") {
    const prefs = await loadPrefs(env);
    return json({
      default: CF_TEXT_MODELS[0],
      workers: MODEL_CHOICES,
      proxy: { bound: !!env.ORPROXY, presets: proxyPresets(env), default_preset: env.ORPROXY_PRESET || OR_PROXY_PRESET },
      server_tools: ["openrouter:web_search", "openrouter:datetime", "openrouter:web_fetch"],
      server_tools_need_key: !env.OPENROUTER_API_KEY,
      openrouter: {
        bound: !!(env.OPENROUTER_API_KEY || env.ORPROXY),
        via: env.OPENROUTER_API_KEY ? "key" : env.ORPROXY ? "proxy" : "none",
        models: OR_CHOICES,
        presets: proxyPresets(env),
      },
      chosen: prefs.model || null,
    });
  }

  // The truth store: public to read, because it is a public knowledge base;
  // expert to write, because confidence only rises when someone vouches.
  if (url.pathname === "/truths") {
    const box = truthStore(env);
    if (!box) return json({ store: null, count: 0, counts: {}, truths: [] });
    const status = String(url.searchParams.get("status") || "").trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
    const all = await truthIndex(env, box);
    const counts = {};
    all.forEach((r) => {
      counts[r.status] = (counts[r.status] || 0) + 1;
    });
    const truths = (status ? all.filter((r) => r.status === status) : all).slice(0, limit);
    return json({
      store: env.TRUTHS ? "TRUTHS" : env.ARCHIVE ? "ARCHIVE" : env.KV ? "KV" : null,
      count: all.length,
      counts,
      truths,
    });
  }

  if (url.pathname.indexOf("/truths/") === 0) {
    const box = truthStore(env);
    if (!box) return json({ error: "No truth store is bound" }, 503);
    const parts = url.pathname.slice("/truths/".length).split("/");
    const id = parts[0];
    if (!/^t_[0-9a-f]{8,32}$/.test(id)) return json({ error: "Need a truth id" }, 400);
    let rec = null;
    try {
      const raw = await box.get("truth:" + id);
      rec = raw ? JSON.parse(raw) : null;
    } catch (err) {}
    if (!rec) return json({ error: "No such truth" }, 404);
    if (parts.length === 1) {
      if (request.method !== "GET") return json({ error: "Use GET, or POST /truths/<id>/approve" }, 405);
      return json({ truth: rec });
    }
    if (parts[1] !== "approve") return json({ error: "Unknown truth action" }, 404);
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    const bad = truthAdmin(env, request);
    if (bad) return json({ error: bad }, bad.indexOf("TRUTH_KEY is not set") >= 0 ? 503 : 403);
    const { body, error } = await readBody(request);
    if (error) return error;
    const saved = await promoteTruth(env, box, rec, body || {});
    await archiveLog(env, {
      t: new Date().toISOString(),
      q: String(rec.question || "").slice(0, 200),
      provider: "truth:approve",
      route: "truth",
      cards: 0,
    });
    return json({ ok: true, truth: saved });
  }

  // Shapes: what a call has to look like. Reading is public; uploading the full
  // catalogue is an expert action, the same key that signs off a truth.
  if (url.pathname === "/shapes") {
    if (request.method === "POST") {
      if (!env.LTM) return json({ error: "No LTM bucket is bound" }, 503);
      const bad = truthAdmin(env, request);
      if (bad) return json({ error: bad }, bad.indexOf("TRUTH_KEY is not set") >= 0 ? 503 : 403);
      const { body, error } = await readBody(request);
      if (error) return error;
      const cat = body && Array.isArray(body.models) ? body : body && body.catalogue;
      if (!cat || !Array.isArray(cat.models)) return json({ error: "Send the catalogue.json contents" }, 400);
      await env.LTM.put(SHAPES_KEY, JSON.stringify(cat), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, key: SHAPES_KEY, models: cat.models.length, generated: cat.generated || null });
    }
    if (request.method !== "GET") return json({ error: "Use GET, or POST with x-truth-key to upload" }, 405);
    let cat = null;
    if (env.LTM) {
      try {
        const obj = await env.LTM.get(SHAPES_KEY);
        if (obj) cat = JSON.parse(await obj.text());
      } catch (err) {
        cat = null;
      }
    }
    if (!cat) {
      return json({
        ok: true,
        source: "built-in",
        card: SHAPE_CARD,
        counts: null,
        note: "catalogue.json is not in LTM yet; POST it with x-truth-key and this serves the full list",
      });
    }
    if (url.searchParams.get("full") === "1") return json(cat);
    return json({
      ok: true,
      source: SHAPES_KEY,
      generated: cat.generated || null,
      counts: cat.counts || null,
      shapes: cat.shapes || null,
      card: SHAPE_CARD,
    });
  }

  if (url.pathname === "/prefs") {
      // POST { reset: true } forgets everything learned, so drift can be undone.
      if (request.method === "POST") {
        const { body, error } = await readBody(request);
        if (error) return error;
        if (!body || body.reset !== true) return json({ error: "Send { reset: true }" }, 400);
        const cleared = await savePrefs(env, { actions: {}, domains: {}, events: [], updated: null });
        return json({ reset: true, cleared, hint: "" });
      }
      const prefs = await loadPrefs(env);
      return json({
        kv: !!env.KV,
        actions: prefs.actions,
        domains: prefs.domains,
        events: (prefs.events || []).slice(-10),
        hint: prefsHint(prefs),
        model: prefs.model || null,
        updated: prefs.updated,
      });
    }

    if (url.pathname === "/route") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleRoute(request, env);
    }

    if (url.pathname === "/search") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleSearch(request, env);
    }

    if (url.pathname === "/cards") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleCards(request, env);
    }

    if (url.pathname === "/notes") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleNotes(request, env);
    }

    if (url.pathname === "/approve") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleApprove(request, env);
    }

    if (url.pathname === "/approved") {
      const proxied = await adminProxy(env, request, "/approved", "");
      if (proxied) return proxied;
      const store = await loadApproved(env);
      const items = Object.entries(store.items || {})
        .sort((a, b) => (b[1].rank || 0) - (a[1].rank || 0) || Date.parse(b[1].updated || 0) - Date.parse(a[1].updated || 0))
        .slice(0, 50)
        .map(([k, v]) => ({ key: k, q: v.q, rank: v.rank, cards: (v.cards || []).length, at: v.at, updated: v.updated }));
      return json({ store: env.ARCHIVE ? "archive" : env.KV ? "kv" : null, count: items.length, items });
    }

    if (url.pathname === "/archive") {
      const arc = arcStore(env);
      let log = [];
      if (arc) {
        try {
          const raw = await arc.get(ARCHIVE_LOG_KEY);
          log = raw ? JSON.parse(raw) : [];
        } catch (err) {
          log = [];
        }
      }
      return json({
        store: env.ARCHIVE ? "archive" : env.KV ? "kv" : null,
        count: Array.isArray(log) ? log.length : 0,
        log: Array.isArray(log) ? log.slice(0, 50) : [],
      });
    }

    if (url.pathname === "/card") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleCard(request, env);
    }

    if (url.pathname === "/deck") {
      // The card list itself, kept in KV so a phone that lost its storage comes
      // back to the same cards.
      const id = String(url.searchParams.get("id") || "");
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return json({ error: "Need a deck id" }, 400);
      const key = "deck:" + id;
      if (request.method === "POST") {
        const { body, error } = await readBody(request);
        if (error) return error;
        const cards = (Array.isArray(body.cards) ? body.cards : []).slice(0, 80).map((c) => ({
          q: String((c && c.q) || "").slice(0, 600),
          a: String((c && c.a) || "").slice(0, 4000),
        }));
        const theme = cleanTheme(body.theme);
        const store = ctxStore(env);
        if (store) await store.put(key, JSON.stringify({ cards, theme: theme || null, updated: new Date().toISOString() }));
        return json({ ok: true, saved: !!store, count: cards.length, theme });
      }
      const store = ctxStore(env);
      if (!store) return json({ cards: [], saved: false });
      const raw = await readMoved(env, store, key);
      let cards = [];
      let theme = null;
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        cards = parsed.cards || [];
        theme = cleanTheme(parsed.theme);
      } catch (err) {
        cards = [];
      }
      return json({ cards, theme, saved: true });
    }

    if (url.pathname === "/feedback") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleFeedback(request, env);
    }

    if (url.pathname === "/chat") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleChat(request, env);
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...cH },
      });
    }

    return new Response("Not found", { status: 404, headers: cH });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cH },
  });
}

async function readBody(request) {
  try {
    return { body: await request.json() };
  } catch (err) {
    return { error: json({ error: "Invalid JSON body" }, 400) };
  }
}

function buildState(prompt, contextCards) {
  if (!contextCards.length) return prompt;
  const history = contextCards
    .map((c) => "User: " + c.q + "\nAssistant: " + (c.r || "(no reply)"))
    .join("\n\n");
  return "Conversation so far:\n" + history + "\n\nNew message:\n" + prompt;
}

function normalized(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// What this question should run on: an explicit pick, the model this person
// chose last time, or nothing so the usual order applies.
async function pickModel(env, body) {
  if (body.proxy === true || String(body.provider || "") === "orproxy") {
    return { proxy: true, preset: String(body.preset || "").trim() };
  }
  const wanted = String(body.model || "").trim();
  if (wanted.indexOf("@cf/") === 0) return { cf: wanted };
  if (wanted.indexOf("proxy:") === 0) return { proxy: true, preset: wanted.slice(6) };
  if (wanted.indexOf("preset:") === 0) return { openrouter: true, preset: wanted.slice(7) };
  if (wanted.indexOf("@preset/") === 0) return { openrouter: true, preset: wanted.slice(8) };
  if (wanted.indexOf("openrouter:") === 0) return { openrouter: true, model: wanted.slice(11) };
  if (wanted && wanted.indexOf("/") > 0) return { openrouter: true, model: wanted };

  const saved = String((await loadPrefs(env)).model || "").trim();
  if (saved.indexOf("@cf/") === 0) return { cf: saved, learned: true };
  if (saved.indexOf("proxy:") === 0) return { proxy: true, preset: saved.slice(6), learned: true };
  if (saved.indexOf("preset:") === 0) return { openrouter: true, preset: saved.slice(7), learned: true };
  if (saved.indexOf("openrouter:") === 0) return { openrouter: true, model: saved.slice(11), learned: true };
  if (saved && saved.indexOf("/") > 0) return { openrouter: true, model: saved, learned: true };
  return {};
}

async function cacheKeyFor(prompt, contextCards, body, env) {
  // A request that asks for the proxy gets its own cache line: an answer from
  // Workers AI is not an answer to "use this other model".
  const which = body.audit === true
    ? "|audit"
    : body.proxy === true || String(body.provider || "") === "orproxy"
      ? "|orproxy:" + String(body.preset || body.model || "")
      : "";
  const key =
    normalized(prompt) +
    "|" +
    JSON.stringify(contextCards.map((c) => normalized(c.q))) +
    "|" +
    (body.model || "") +
    "|" +
    (env.CF_CHAT_MODEL || "") +
    which;
  return "ans:" + (await hashKey(key));
}

// What actually answered, and whether it worked. Kept in CONTEXT with the other
// learned preferences, so this needs no extra namespace: it is one more key.
// The fallback ladder is the safety net; these numbers are what stop it
// retrying a model that keeps failing and start preferring one that answers.
const SCORES_KEY = "scores:v1";

function emptyScores() {
  return { models: {}, updated: null };
}

async function loadScores(env) {
  const store = ctxStore(env);
  if (!store) return emptyScores();
  try {
    const raw = await store.get(SCORES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.models && typeof parsed.models === "object" ? parsed : emptyScores();
  } catch (err) {
    return emptyScores();
  }
}

// Laplace-smoothed, so one lucky answer does not outrank a model with a record,
// and a model that has never run sits at 0.5 rather than at the bottom.
function scoreOf(scores, domain, model) {
  const row = scores && scores.models ? scores.models[model] : null;
  if (!row) return 0.5;
  const key = "n:" + (domain || "general");
  const dn = Number(row[key]) || 0;
  const n = dn || Number(row.n) || 0;
  const ok = dn ? Number(row["ok:" + (domain || "general")]) || 0 : Number(row.ok) || 0;
  return (ok + 1) / (n + 2);
}

async function noteAttempt(env, domain, model, ok) {
  const store = ctxStore(env);
  if (!store || !model) return false;
  const d = domain || "general";
  const scores = await loadScores(env);
  const row = scores.models[model] || { n: 0, ok: 0 };
  row.n = (Number(row.n) || 0) + 1;
  row.ok = (Number(row.ok) || 0) + (ok ? 1 : 0);
  row["n:" + d] = (Number(row["n:" + d]) || 0) + 1;
  row["ok:" + d] = (Number(row["ok:" + d]) || 0) + (ok ? 1 : 0);
  row.last = new Date().toISOString();
  scores.models[model] = row;
  scores.updated = row.last;
  const keys = Object.keys(scores.models);
  if (keys.length > 40) {
    keys.sort((a, b) => scoreOf(scores, d, a) - scoreOf(scores, d, b));
    keys.slice(0, keys.length - 40).forEach((k) => delete scores.models[k]);
  }
  await store.put(SCORES_KEY, JSON.stringify(scores));
  return true;
}

// ─── decision layer ───────────────────────────────────────────────────────────

async function decide(env, state, questions) {
  if (!env.AI) throw new Error("AI binding not configured");
  const res = await env.AI.run(CLEF_MODEL, {
    model: "clef-flash",
    state,
    questions: questions && typeof questions === "object" ? questions : QUESTIONS,
  });

  const answers = (res && res.answers) || res || {};
  return {
    intent: readChoice(answers.intent),
    shape: readChoice(answers.shape),
    domain: readChoice(answers.domain),
    tone: readChoice(answers.tone),
    depth: readScore(answers.depth),
    clarify: readProbability(answers.clarify),
    needs_web: readProbability(answers.needs_web),
    cache_ok: readProbability(answers.cache_ok),
    sensitive: readProbability(answers.sensitive),
  };
}

function planRoute(decision) {
  const d = decision || {};
  const domain = DOMAINS[d.domain] ? d.domain : "general";
  const pack = DOMAINS[domain];

  const needsWeb = d.needs_web != null ? d.needs_web >= WEB_THRESHOLD : pack.web >= WEB_THRESHOLD;
  const care = d.sensitive != null ? d.sensitive >= CARE_THRESHOLD : !!pack.risk;
  const stable = d.cache_ok != null ? d.cache_ok >= STABLE_THRESHOLD : pack.stable !== false;

  return {
    domain,
    label: pack.label,
    search: needsWeb && !pack.noWeb,
    care: care || !!pack.risk,
    stable,
    ttl: stable ? TTL_STABLE : TTL_VOLATILE,
    pack,
  };
}

// What the decision layer is unsure about, turned into questions a person can
// answer on a phone. Each answer is sent back with the question, so the next
// decision is made with more of this person's actual intent.
function clarifyQuestions(decision, said) {
  const d = decision || {};
  const asked = new Set((said || []).map((s) => String((s && s.id) || "")));
  const out = [];

  if (!asked.has("web") && typeof d.needs_web === "number" && d.needs_web >= WEB_ASK_LOW && d.needs_web < WEB_ASK_HIGH) {
    out.push({
      id: "web",
      q: "Should I search the web for this, or answer from what the model already knows?",
      options: ["Search the web", "Answer from knowledge"],
    });
  }
  if (!asked.has("goal") && typeof d.clarify === "number" && d.clarify >= 0.5) {
    out.push({
      id: "goal",
      q: "What do you want back: the short answer, the reasoning, or the steps to act on?",
      options: ["Short answer", "The reasoning", "Steps to act on"],
    });
  }
  if (!asked.has("target") && typeof d.clarify === "number" && d.clarify >= 0.75) {
    out.push({
      id: "target",
      q: "Who is this for, and what are you going to do with it?",
      options: [],
    });
  }
  return out.slice(0, 2);
}

function readChoice(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  const direct = v.choice ?? v.label ?? v.value ?? v.answer ?? v.selected ?? v.top ?? null;
  if (typeof direct === "string") return direct;
  const probs = v.probabilities ?? v.options ?? v.scores ?? null;
  if (probs && typeof probs === "object") {
    let best = null;
    let bestP = -Infinity;
    for (const [key, val] of Object.entries(probs)) {
      const p =
        typeof val === "number"
          ? val
          : val && typeof val.probability === "number"
            ? val.probability
            : -Infinity;
      if (p > bestP) {
        bestP = p;
        best = key;
      }
    }
    if (best) return best;
  }
  return null;
}

function readScore(v) {
  if (v == null) return null;
  if (typeof v === "number") return Math.round(v * 100) / 100;
  if (typeof v === "string") return v;
  const s = v.score ?? v.value ?? v.probability ?? null;
  if (typeof s === "number") return Math.round(s * 100) / 100;
  if (typeof s === "string") return s;
  return null;
}

function readProbability(v) {
  if (v == null) return null;
  if (typeof v === "number") return clamp01(v);
  const p = v.probability ?? v.score ?? v.value ?? null;
  if (typeof p === "number") return clamp01(p);
  return null;
}

function clamp01(n) {
  return n > 1 ? Math.round(n) / 100 : Math.round(n * 100) / 100;
}

const INTENT_STYLE = {
  answer: "Answer directly and factually.",
  list: "Answer as a short, scannable list.",
  build: "Answer with concrete code or markup in fenced blocks, then one line of explanation.",
  decide: "Give a clear recommendation first, then the reasoning behind it.",
  meta: "Answer as a note about this conversation or application.",
};

function styleHint(d) {
  const bits = [];
  if (!d) return "";
  if (d.intent && INTENT_STYLE[d.intent]) bits.push(INTENT_STYLE[d.intent]);
  else if (d.intent) bits.push("Shape the answer as: " + d.intent + ".");
  if (typeof d.depth === "number") {
    if (d.depth < 0.5) bits.push("Keep it to one or two sentences.");
    else if (d.depth > 2.5) bits.push("Be thorough and structured.");
    else if (d.depth > 1.5) bits.push("Give a full but tight explanation.");
    else bits.push("Keep it to a short paragraph.");
  }
  if (d.tone === "technical") bits.push("Use precise technical language.");
  if (d.tone === "warm") bits.push("Keep the tone friendly and conversational.");
  if (d.tone === "plain") bits.push("Use plain everyday language.");
  if (typeof d.clarify === "number" && d.clarify >= 0.5) {
    bits.push("The request may be ambiguous: state your assumption in one short line, then answer.");
  }
  return bits.join(" ");
}

// ─── web search (Cloudflare Web Search API via the AI binding) ────────────────

// --- notes (Cloudflare AI Search) -------------------------------------------
//
// A card is a note. /search is how the human sees what the system already
// knows, /chat/completions is how the model asks the same notes, and every
// answered card is written back so both sides keep learning from each other.

function aiSearchBase(env) {
  return String(env.AI_SEARCH_URL || AI_SEARCH_URL).replace(/\/+$/, "");
}

async function aiSearchPost(env, path, payload) {
  const res = await fetch(aiSearchBase(env) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {}
  if (!res.ok) {
    const detail =
      (data && data.error && (data.error.message || data.error)) ||
      (data && data.errors && JSON.stringify(data.errors)) ||
      text.slice(0, 300) ||
      "no body";
    const err = new Error(path + " HTTP " + res.status + ": " + detail);
    err.status = res.status;
    throw err;
  }
  if (!data) throw new Error(path + " returned non-JSON");
  return data;
}

function chunkNotes(data) {
  const root = (data && data.result) || data || {};
  const chunks = Array.isArray(root.chunks) ? root.chunks : [];
  return chunks
    .filter((c) => c && (c.text || c.item))
    .map((c) => {
      const item = (c && c.item) || {};
      const meta = item.metadata || {};
      return {
        title: String(meta.title || item.key || "card"),
        text: String((c && c.text) || "").slice(0, 1200),
        score: typeof c.score === "number" ? c.score : null,
      };
    });
}

// The human side of the loop: what do the notes already know about this?
async function relatedNotes(env, query, limit) {
  const data = await aiSearchPost(env, "/search", {
    messages: [{ role: "user", content: String(query).slice(0, 4000) }],
  });
  const notes = chunkNotes(data);
  return Number.isFinite(limit) && limit > 0 ? notes.slice(0, limit) : notes;
}

// The model side of the loop: ask the notes, in OpenAI shape.
async function notesChat(env, messages, body) {
  return aiSearchPost(env, "/chat/completions", {
    messages,
    max_tokens: body.max_tokens || 1200,
    temperature: body.temperature ?? 0.7,
  });
}

async function cloudflareWebSearch(env, query, limit) {
  if (!env.AI || typeof env.AI.websearch !== "function") {
    throw new Error("websearch() is not available on this AI binding");
  }
  const res = await env.AI.websearch({
    gatewayId: env.AI_GATEWAY_ID || "default",
    query: String(query).slice(0, 1024),
    provider: env.SEARCH_PROVIDER || "ceramic",
    limit,
  });
  if (!res || !res.ok) {
    throw new Error("web search HTTP " + (res ? res.status : "no response"));
  }
  const data = await res.json();
  const items = Array.isArray(data && data.items) ? data.items : [];
  return items
    .filter((i) => i && i.url)
    .map((i) => ({
      url: i.url,
      title: i.title || i.url,
      description: String(i.description || "").slice(0, 800),
    }));
}

// Cloudflare's websearch() bills every query to AI Gateway credits and answers
// 402 on an account without them, which used to leave the card builder with no
// sources and the page with no cards. These two need no key and no billing, so
// a question still gets real pages to stand on.

function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function ddgUrl(href) {
  const raw = String(href || "");
  const m = /[?&]uddg=([^&]+)/.exec(raw);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (err) {
      return "";
    }
  }
  return /^https?:\/\//.test(raw) ? raw : "";
}

async function ddgSearch(query, limit) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; cards/1.0)",
    },
    body: "q=" + encodeURIComponent(String(query).slice(0, 400)),
  });
  if (!res.ok) throw new Error("duckduckgo HTTP " + res.status);
  const html = await res.text();
  const urls = [];
  const titles = [];
  const linkRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && urls.length < limit) {
    const url = ddgUrl((/href="([^"]+)"/i.exec(m[0]) || [])[1]);
    if (!url) continue;
    if (urls.indexOf(url) >= 0) continue;
    urls.push(url);
    titles.push(stripTags(m[0].slice(m[0].indexOf(">") + 1)) || url);
  }
  const snips = [];
  const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi;
  while ((m = snipRe.exec(html)) && snips.length < limit) snips.push(stripTags(m[1]));
  return urls.map((url, i) => ({ url, title: titles[i], description: snips[i] || "" }));
}

async function wikipediaSearch(query, limit) {
  const res = await fetch(
    "https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=" +
      limit +
      "&srsearch=" +
      encodeURIComponent(String(query).slice(0, 300)),
    { headers: { "User-Agent": "cards/1.0 (cloudflare worker)" } }
  );
  if (!res.ok) throw new Error("wikipedia HTTP " + res.status);
  const data = await res.json();
  const hits = (data && data.query && data.query.search) || [];
  const pages = hits.slice(0, limit).map((hit) => ({
    title: String((hit && hit.title) || ""),
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String((hit && hit.title) || "").replace(/ /g, "_")),
    fallback: stripTags(hit && hit.snippet),
  }));
  return Promise.all(
    pages.map(async (page) => {
      let description = page.fallback;
      try {
        const sum = await fetch(
          "https://en.wikipedia.org/api/rest_v1/page/summary/" +
            encodeURIComponent(page.title.replace(/ /g, "_")),
          { headers: { "User-Agent": "cards/1.0 (cloudflare worker)" } }
        );
        if (sum.ok) {
          const j = await sum.json();
          if (j && j.extract) description = String(j.extract).slice(0, 800);
        }
      } catch (err) {}
      return { url: page.url, title: page.title || page.url, description };
    })
  );
}

function xmlText(s) {
  return stripTags(String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

// Bing publishes results as RSS, which needs no key. It is opt-in via
// SEARCH_BING=1 because its RSS feed answers most queries with a did-you-mean
// result ("make vs. makes") instead of the query, which poisons the cards.
async function bingSearch(query, limit) {
  const res = await fetch(
    "https://www.bing.com/search?format=rss&count=" + limit + "&q=" + encodeURIComponent(String(query).slice(0, 300)),
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; cards/1.0)",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    }
  );
  if (!res.ok) throw new Error("bing HTTP " + res.status);
  const xml = await res.text();
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < limit) {
    const block = m[1];
    const url = xmlText((/<link>([\s\S]*?)<\/link>/i.exec(block) || [])[1]);
    if (!/^https?:\/\//.test(url)) continue;
    const title = xmlText((/<title>([\s\S]*?)<\/title>/i.exec(block) || [])[1]);
    const description = xmlText((/<description>([\s\S]*?)<\/description>/i.exec(block) || [])[1]);
    out.push({ url, title: title || url, description: description.slice(0, 800) });
  }
  return out;
}

// Repositories as sources: a question about building something gets real
// projects back, which the card builder turns into principles.
async function githubSearch(env, query, limit) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "cards/1.0" };
  if (env.GITHUB_TOKEN) headers.Authorization = "Bearer " + env.GITHUB_TOKEN;
  const res = await fetch(
    "https://api.github.com/search/repositories?sort=stars&per_page=" +
      limit +
      "&q=" +
      encodeURIComponent(String(query).slice(0, 256)),
    { headers }
  );
  if (!res.ok) throw new Error("github HTTP " + res.status);
  const data = await res.json();
  return ((data && data.items) || []).slice(0, limit).map((repo) => ({
    url: repo.html_url,
    title: String(repo.full_name || "") + (repo.stargazers_count != null ? " (" + repo.stargazers_count + " stars)" : ""),
    description: String(repo.description || "").slice(0, 800),
  }));
}

// His own search Worker, deployed from any repository, is pointed at with
// SEARCH_URL. {q} is swapped when present, otherwise the query is appended.
// Any reply shaped as an array or {results|items|sources|data|hits} works.
// ─── the OpenCode agent harness, over a Service binding ─────────────────────
// The harness exposes its agent as a Worker entrypoint (binding OCODE), so it
// can be driven as RPC instead of over HTTP. Whichever callable method exists
// answers the query; the reply may be a list of results, a JSON string, or
// prose that mentions links, and all three become sources.
const HARNESS_METHODS = ["search", "webSearch", "web_search", "ask", "prompt", "run", "answer"];

function harnessList(list, limit) {
  return list
    .slice(0, limit)
    .map((hit) => ({
      url: hit.url || hit.link || hit.href || "",
      title: hit.title || hit.name || hit.url || hit.link || "",
      description: String(hit.description || hit.snippet || hit.text || hit.summary || "").slice(0, 800),
    }))
    .filter((hit) => /^https?:\/\//i.test(String(hit.url)));
}

function harnessLinks(text, limit) {
  const out = [];
  const seen = new Set();
  const md = /\[([^\]\n]{3,160})\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = md.exec(text)) && out.length < limit) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({
      url: m[2],
      title: m[1],
      description: text.slice(Math.max(0, m.index - 140), m.index).replace(/\s+/g, " ").trim(),
    });
  }
  if (out.length) return out;
  const bare = /https?:\/\/[^\s"'<>)\]]+/g;
  let b;
  while ((b = bare.exec(text)) && out.length < limit) {
    const url = b[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: url.replace(/^https?:\/\//, "").slice(0, 80),
      description: text.slice(Math.max(0, b.index - 140), b.index).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

function harnessItems(reply, limit) {
  if (reply == null) return [];
  if (Array.isArray(reply)) return harnessList(reply, limit);
  if (typeof reply === "string") {
    const text = reply.trim();
    if (!text) return [];
    try {
      return harnessItems(JSON.parse(text), limit);
    } catch (err) {}
    return harnessLinks(text, limit);
  }
  if (typeof reply === "object") {
    for (const key of ["results", "items", "sources", "hits", "data", "pages"]) {
      if (Array.isArray(reply[key])) {
        const list = harnessList(reply[key], limit);
        if (list.length) return list;
      }
    }
    for (const key of ["text", "answer", "response", "message"]) {
      if (typeof reply[key] === "string" && reply[key].trim()) {
        const links = harnessLinks(reply[key], limit);
        if (links.length) return links;
      }
    }
  }
  return [];
}

async function harnessSearch(env, query, limit) {
  const binder = env.OCODE;
  if (!binder) throw new Error("OCODE is not bound");
  const notes = [];
  for (const name of HARNESS_METHODS) {
    const fn = binder[name];
    if (typeof fn !== "function") continue;
    try {
      const call = Promise.resolve(fn.length >= 2 ? fn.call(binder, String(query), limit) : fn.call(binder, String(query)));
      const reply = await Promise.race([
        call,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 25000)),
      ]);
      const items = harnessItems(reply, limit);
      notes.push(name + ": " + items.length);
      if (items.length) {
        items.engine = name;
        items.sample = String((items[0] && items[0].title) || "").slice(0, 60);
        return items;
      }
    } catch (err) {
      notes.push(name + ": " + (err && err.message ? err.message : String(err)));
    }
  }
  throw new Error(notes.length ? "no usable reply (" + notes.join(", ") + ")" : "no callable method on OCODE");
}

async function externalSearch(env, query, limit) {
  const base = String(env.SEARCH_URL || "");
  if (!base) throw new Error("SEARCH_URL is not set");
  const method = String(env.SEARCH_METHOD || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const q = encodeURIComponent(String(query).slice(0, 300));
  const target = base.indexOf("{q}") >= 0 ? base.split("{q}").join(q) : base + (base.indexOf("?") >= 0 ? "&" : "?") + "q=" + q;
  const init = {
    method: method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  };
  if (method === "POST") init.body = JSON.stringify({ query: String(query), limit: limit });
  const res = await fetch(target, init);
  if (!res.ok) throw new Error("search worker HTTP " + res.status);
  const data = await res.json();
  const list = Array.isArray(data)
    ? data
    : (data && (data.results || data.items || data.sources || data.data || data.hits)) || [];
  return list
    .slice(0, limit)
    .map((hit) => ({
      url: hit.url || hit.link || hit.href || "",
      title: hit.title || hit.name || hit.url || hit.link || "",
      description: String(hit.description || hit.snippet || hit.text || hit.summary || "").slice(0, 800),
    }))
    .filter((hit) => /^https?:\/\//.test(String(hit.url)));
}

// Headless Chromium from Cloudflare's own edge (Workers Browser Rendering).
// A real page loads the results HTML the way a visitor would, which is the
// one route that survives the blocks that hit plain fetches from a Worker.
// Needs the `browser` binding (env.BROWSER); without it the chain skips this.
const STOPWORDS = new Set([
  "what", "when", "where", "which", "while", "this", "that", "these", "those",
  "with", "from", "into", "about", "your", "their", "there", "they", "them",
  "then", "than", "have", "has", "had", "does", "did", "doing", "just", "only",
  "also", "more", "most", "very", "much", "some", "such", "other", "been",
  "being", "will", "would", "should", "could", "after", "before", "between",
  "under", "over",
]);

function queryTerms(query) {
  const seen = new Set();
  const out = [];
  for (const raw of String(query || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

// How many distinct query words a page actually mentions. Search pages hand
// back a did-you-mean result for anything they do not like, and that has to
// be caught here rather than turned into a card.
function relevanceOf(item, terms) {
  if (!terms.length) return 1;
  const words = (
    String(item.title || "") +
    " " +
    String(item.description || "") +
    " " +
    String(item.url || "")
  )
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let hits = 0;
  for (const term of terms) {
    // Four letters of the term is enough to see its family, so "trading"
    // notices a page about "trade" instead of calling it off-topic.
    const stem = term.slice(0, 4);
    if (words.some((word) => word.length >= 3 && (word.indexOf(stem) === 0 || term.indexOf(word) === 0))) hits++;
  }
  return hits;
}

// Real desktop Chrome on a real page: the JS-driven DuckDuckGo page first,
// then its server-rendered fallbacks. Bing is last because its edge answers
// with a did-you-mean page whatever the transport.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const BROWSER_ENGINES = [
  {
    name: "ddg",
    url: (q) => "https://duckduckgo.com/?q=" + q,
    selector: 'article[data-testid="result"]',
  },
  {
    name: "ddg-html",
    url: (q) => "https://html.duckduckgo.com/html/?q=" + q,
    selector: "article.result, div.result",
  },
  {
    name: "ddg-lite",
    url: (q) => "https://lite.duckduckgo.com/lite/?q=" + q,
    selector: "a.result-link",
  },
  {
    name: "bing",
    url: (q) => "https://www.bing.com/search?count=20&q=" + q,
    selector: "li.b_algo",
  },
];

async function browserPuppeteer() {
  if (globalThis.__codsPuppeteer) return globalThis.__codsPuppeteer;
  const mod = await import("@cloudflare/puppeteer");
  return mod.default || mod;
}

// Rows straight off the page: drop anything that is not a real link, and
// keep the first `limit` distinct URLs.
function browserItems(rows, limit) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const url = String((row && row.url) || "");
    if (!/^https?:\/\//.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: stripTags(row.title) || url,
      description: String(row.description || "").slice(0, 800),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function browserSearch(env, query, limit) {
  if (!env.BROWSER) throw new Error("no BROWSER binding");
  const puppeteer = await browserPuppeteer();
  const q = encodeURIComponent(String(query).slice(0, 300));
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    for (const engine of BROWSER_ENGINES) {
      let page = null;
      try {
        page = await browser.newPage();
        if (typeof page.setUserAgent === "function") {
          try {
            await page.setUserAgent(BROWSER_UA);
          } catch (err) {}
        }
        await page.goto(engine.url(q), { waitUntil: "load", timeout: 20000 });
        // A results page that paints after load needs a moment before the
        // rows exist; giving up early is what makes a real browser look empty.
        if (typeof page.waitForSelector === "function") {
          try {
            await page.waitForSelector(engine.selector, { timeout: 8000 });
          } catch (err) {}
        }
        const rows = await page.evaluate((selector) => {
          return Array.from(document.querySelectorAll(selector)).map((row) => {
            const a = row.matches && row.matches("a") ? row : row.querySelector("h2 a") || row.querySelector("a");
            const p = row.querySelector("p");
            return {
              url: a ? a.href : "",
              title: a ? a.textContent.trim() : "",
              description: p ? p.textContent.trim() : "",
            };
          });
        }, engine.selector);
        const items = browserItems(rows, limit);
        // Carry the provenance out with the rows, so a failure downstream can
        // say which engine answered and what it actually said.
        items.engine = engine.name;
        items.seen = (rows || []).length;
        items.sample = String(((rows || [])[0] || {}).title || "").slice(0, 60);
        if (items.length) return items;
      } catch (err) {
        // that engine did not load; the next one gets a turn
      } finally {
        try {
          if (page) await page.close();
        } catch (err) {}
      }
    }
    return [];
  } finally {
    try {
      await browser.close();
    } catch (err) {}
  }
}

// Providers in order of quality. The first that returns two or more pages
// wins; a single page is kept as a fallback so one source still grounds.
async function webSearch(env, query) {
  const limit = Number(env.SEARCH_LIMIT || 5);
  const terms = queryTerms(query);
  // Short queries are matched loosely, longer ones have to land three of
  // their words: a long query that only trips two incidental words is the
  // shape of an off-topic page, not an answer.
  const need = terms.length >= 5 ? Math.min(3, terms.length) : Math.min(2, Math.max(1, terms.length));
  // Engines that answer with did-you-mean pages, and the encyclopedia that
  // happily returns an unrelated article, have to prove they are on topic.
  const noisy = new Set(["browser", "bing", "wikipedia"]);
  const errors = [];
  let best = null;
  const providers = [];
  if (env.OCODE) providers.push(["harness", () => harnessSearch(env, query, limit)]);
  if (env.SEARCH_URL) providers.push(["search-url", () => externalSearch(env, query, limit)]);
  if (env.BROWSER) providers.push(["browser", () => browserSearch(env, query, limit)]);
  providers.push(["cloudflare", () => cloudflareWebSearch(env, query, limit)]);
  if (String(env.SEARCH_BING || "") === "1") providers.push(["bing", () => bingSearch(query, limit)]);
  providers.push(["duckduckgo", () => ddgSearch(query, limit)]);
  providers.push(["github", () => githubSearch(env, query, limit)]);
  providers.push(["wikipedia", () => wikipediaSearch(query, limit)]);
  for (const [via, run] of providers) {
    try {
      const raw = await run();
      const fresh = raw.filter((s) => s && s.url);
      const label = raw.engine ? via + "(" + raw.engine + ")" : via;
      const found = noisy.has(via) ? fresh.filter((s) => relevanceOf(s, terms) >= need) : fresh;
      if (found.length < fresh.length) {
        errors.push(
          label + ": dropped " + (fresh.length - found.length) + " of " + fresh.length + " off-topic" +
            (raw.sample ? ' (first was "' + raw.sample + '")' : "")
        );
      }
      if (found.length >= 2) return { sources: found, via, errors };
      if (found.length) {
        if (!best || found.length > best.sources.length) best = { sources: found, via };
        errors.push(via + ": only " + found.length + " result");
      } else {
        errors.push(via + ": no results");
      }
    } catch (err) {
      errors.push(via + ": " + err.message);
    }
  }
  if (best) return { sources: best.sources, via: best.via, errors };
  const err = new Error(errors.join(" | ") || "no search provider");
  err.errors = errors;
  throw err;
}

// ─── routing endpoints ────────────────────────────────────────────────────────

// --- writing cards back as notes --------------------------------------------

function cardDoc({ q, a, decision, sources }) {
  const lines = ["# " + String(q || "").trim(), "", String(a || "").trim()];
  const tags = [];
  if (decision && decision.domain) tags.push("domain: " + decision.domain);
  if (decision && decision.intent) tags.push("intent: " + decision.intent);
  if (decision && decision.tone) tags.push("tone: " + decision.tone);
  if (tags.length) lines.push("", tags.join(" / "));
  if (Array.isArray(sources) && sources.length) {
    lines.push("", "Sources:", ...sources.map((s, i) => "[" + (i + 1) + "] " + s.title + " - " + s.url));
  }
  lines.push("", "Saved: " + new Date().toISOString());
  return lines.join("\n");
}

function indexHandle(env) {
  const binding = env.mainspace || env.AI_SEARCH;
  if (!binding) return null;
  if (binding.items && typeof binding.items.upload === "function") return binding;
  if (typeof binding.get === "function") {
    return binding.get(env.AI_SEARCH_INSTANCE || AI_SEARCH_INSTANCE);
  }
  return null;
}

async function indexCard(env, card) {
  const name =
    "cards/" + (await hashKey(String(card.q || "") + "|" + String(card.a || ""))).slice(0, 32) + ".md";
  const doc = cardDoc(card);

  const handle = indexHandle(env);
  if (handle) {
    const item = await handle.items.upload(name, doc);
    return "indexed " + (item && item.key ? item.key : name);
  }

  if (env.CF_ACCOUNT_ID && env.AI_SEARCH_TOKEN) {
    const form = new FormData();
    form.append("file", new Blob([doc], { type: "text/markdown" }), name.split("/").pop());
    const res = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" +
        env.CF_ACCOUNT_ID +
        "/ai-search/namespaces/" +
        (env.AI_SEARCH_NAMESPACE || "default") +
        "/instances/" +
        (env.AI_SEARCH_INSTANCE || AI_SEARCH_INSTANCE) +
        "/items",
      { method: "POST", headers: { Authorization: "Bearer " + env.AI_SEARCH_TOKEN }, body: form }
    );
    const text = await res.text();
    if (!res.ok) throw new Error("upload HTTP " + res.status + ": " + text.slice(0, 200));
    return "indexed " + name;
  }

  throw new Error("no index writer: add the AI Search binding, or CF_ACCOUNT_ID + AI_SEARCH_TOKEN");
}

// The human's side: ask the notes directly, nothing generated.
async function handleSearch(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const query = String(body.query || body.prompt || body.q || "").trim();
  if (!query) return json({ error: "No query" }, 400);

  try {
    const data = await aiSearchPost(env, "/search", {
      messages: [{ role: "user", content: query.slice(0, 4000) }],
    });
    const root = (data && data.result) || data || {};
    const chunks = Array.isArray(root.chunks) ? root.chunks : [];
    return json({
      query,
      search_query: root.search_query || query,
      count: chunks.length,
      notes: chunkNotes(data),
    });
  } catch (err) {
    return json({ error: err.message, query }, 502);
  }
}

// Save cards as notes. Merge / extract in the card menu posts here.
async function handleCards(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const cards = Array.isArray(body.cards) ? body.cards : [body];
  const results = [];
  for (const card of cards) {
    const q = String((card && (card.q || card.prompt)) || "").trim();
    const a = String((card && (card.a || card.r || card.answer)) || "").trim();
    if (!q && !a) {
      results.push({ error: "card has no prompt or answer" });
      continue;
    }
    try {
      results.push({
        q,
        indexed: await indexCard(env, { q, a, decision: card.decision || null, sources: card.sources || null }),
      });
    } catch (err) {
      results.push({ q, error: err.message });
    }
  }
  return json({ count: results.length, results });
}

// What the human thought of a card. Saved as a note so the decision layer
// accumulates which answers held up and which did not.
// ─── what the user's feedback taught the system ─────────────────────────────
// One record in KV. Every card press moves a counter, and every later question
// reads those counters back as a sentence, so the decision layer and the card
// writer both lean towards what this person has actually rewarded.
const PREFS_KEY = "prefs:v1";

async function loadPrefs(env) {
  const empty = { actions: {}, domains: {}, events: [], updated: null };
  const store = ctxStore(env);
  if (!store) return empty;
  try {
    const raw = await readMoved(env, store, PREFS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) || {};
    return {
      actions: parsed.actions && typeof parsed.actions === "object" ? parsed.actions : {},
      domains: parsed.domains && typeof parsed.domains === "object" ? parsed.domains : {},
      events: Array.isArray(parsed.events) ? parsed.events : [],
      model: parsed.model || null,
      updated: parsed.updated || null,
    };
  } catch (err) {
    return empty;
  }
}

async function savePrefs(env, prefs) {
  const store = ctxStore(env);
  if (!store) return false;
  prefs.updated = new Date().toISOString();
  prefs.events = (prefs.events || []).slice(-24);
  await store.put(PREFS_KEY, JSON.stringify(prefs));
  return true;
}

function prefsHint(prefs) {
  const a = (prefs && prefs.actions) || {};
  const parts = [];
  if (a.deeper) parts.push("wants more depth (deeper x" + a.deeper + ")");
  if (a.more) parts.push("wants more angles (more x" + a.more + ")");
  if (a.again) parts.push("wants fresher sources (again x" + a.again + ")");
  if (a.wrong) parts.push("called earlier answers off target (wrong x" + a.wrong + ")");
  if (prefs && prefs.model) parts.push("picks " + prefs.model + " to answer");
  const domains = Object.entries((prefs && prefs.domains) || {})
    .filter(([, v]) => v && (v.n || 0) > 0)
    .sort((x, y) => (y[1].n || 0) - (x[1].n || 0))
    .slice(0, 3)
    .map(([d, v]) => d + " (" + (v.n || 0) + ")");
  let hint = "";
  if (parts.length) hint = "Learned from this user's cards: " + parts.join("; ") + ".";
  if (domains.length) hint += (hint ? " " : "") + "Most feedback is in: " + domains.join(", ") + ".";
  return hint.trim();
}

// ─── card operations ─────────────────────────────────────────────────────────
// The card menu is not a separate feature: continue, rewrite, split and merge
// all run the same decision model first, so the domain, the care rules and
// what this person has taught the system still steer every card.
const CARD_OPS = {
  continue: "Extend the answer with the next step of the thinking. Keep it under 900 characters.",
  magic: "Rewrite the answer so it is clearer and tighter. Keep the meaning. Under 900 characters.",
  style: "Rewrite the answer in the requested style. Keep the meaning. Under 900 characters.",
  split: "Return two or three numbered cards, each on its own subject. Start each one with Card 1: or Card 2: on its own line.",
  merge: "Combine the cards into one card. Under 1000 characters.",
};

// Split is the one op that can silently lie: a model that ignores the separator
// gives one blob, and duplicating it would show two identical cards. Parts are
// deduped, and a single honest card beats a fake pair.
function splitParts(text) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  let parts = String(text || "")
    .split(/\n\s*-{3,}\s*\n/)
    .map(norm)
    .filter((s) => s.length > 40);
  if (parts.length < 2) {
    const numbered = String(text || "")
      .split(/\n\s*(?:#{1,3}\s*)?card\s*\d+\s*[:.)-]\s*/i)
      .map(norm)
      .filter((s) => s.length > 40);
    if (numbered.length > 1) parts = numbered;
  }
  if (parts.length < 2) parts = paragraphsOf(text).map(norm);
  if (parts.length < 2) {
    const sentences = sentenceSplit(text);
    if (sentences.length >= 4) {
      const half = Math.ceil(sentences.length / 2);
      parts = [sentences.slice(0, half).join(" "), sentences.slice(half).join(" ")];
    }
  }
  const seen = new Set();
  const out = [];
  parts
    // A model that answers "Card 1: ..." should not keep the label in the card.
    .map((p) => p.replace(/^(?:#{1,3}\s*)?card\s*\d+\s*[:.)-]\s*/i, "").replace(/^\d+[.)]\s+/, "").trim())
    .forEach((p) => {
      const key = p.slice(0, 120).toLowerCase();
      if (p.length > 40 && !seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    });
  return out;
}

function paragraphsOf(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40);
}

async function handleCard(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const op = String(body.op || "");
  if (!CARD_OPS[op]) return json({ error: "Unknown op: " + (op || "(none)") }, 400);

  const one = body.card && typeof body.card === "object" ? body.card : null;
  const many = Array.isArray(body.cards) ? body.cards.filter((c) => c && (c.a || c.q)).slice(0, 6) : [];
  if (op === "merge" ? many.length < 2 : !one) {
    return json({ error: op === "merge" ? "Merge needs at least two cards" : "No card sent" }, 400);
  }

  const material =
    op === "merge"
      ? many
          .map((c, i) => "Card " + (i + 1) + " request: " + String(c.q || "") + "\nanswer: " + String(c.a || ""))
          .join("\n\n")
      : "Request: " + String(one.q || one.prompt || "") + "\nAnswer: " + String(one.a || "");
  const instruction = String(body.instruction || "").slice(0, 400);
  const failures = [];

  let decision = null;
  try {
    decision = await decide(env, [instruction, material].filter(Boolean).join("\n\n"));
  } catch (err) {
    failures.push("clef-flash: " + err.message);
  }
  const plan = planRoute(decision);
  const learned = prefsHint(await loadPrefs(env));

  const systemBits = [
    CARD_OPS[op],
    styleHint(decision),
    plan.pack.guidance,
    plan.care ? plan.pack.safety : "",
    learned,
    instruction,
  ].filter(Boolean);

  let text = "";
  let provider = "";
  try {
    const r = await askText(
      env,
      [
        { role: "system", content: systemBits.join("\n") },
        { role: "user", content: material },
      ],
      { max_tokens: 800, temperature: 0.5 }
    );
    text = r.text;
    provider = r.provider;
  } catch (err) {
    failures.push("model: " + err.message);
    return json({ error: "No model answered", failures }, 502);
  }

  let cards;
  if (op === "split") {
    const list = splitParts(text);
    if (!list.length) {
      cards = [{ q: String(one.q || "Card"), a: text, provider }];
    } else {
      cards = list.slice(0, 4).map((t, i) => ({
        q: String((one.q || "Card") + " · " + (i + 1)),
        a: t,
        provider,
      }));
    }
  } else {
    cards = [
      {
        q: (op === "merge" ? "Merged: " : "") + String((many[0] && many[0].q) || (one && one.q) || ""),
        a: text,
        provider,
      },
    ];
  }

  return json({ op, cards, provider, decision: slimDecision(decision), learned, failures });
}

// ─── themes and approved answers ─────────────────────────────────────────────
// Two memories the page leans on: how it looks, and which answers this person
// has signed off on. Approved answers are checked before the model is asked,
// so the same question always returns the same vetted cards.
const APPROVED_KEY = "approved:v1";
const APPROVED_LIMIT = 200;
const ARCHIVE_LOG_KEY = "archive:log:v1";

// Memory is split by how long it should live. CONTEXT holds what the app knows
// about this person (learned preferences, decks, theme); ARCHIVE keeps the
// answers that were signed off and a log of what was asked; KV stays the
// short-lived answer cache; LTM (R2) keeps every answer for good. Each one
// falls back to KV so a Worker deployed without them still works.
function ctxStore(env) {
  return env.CONTEXT || env.KV || null;
}
function arcStore(env) {
  return env.ARCHIVE || env.KV || null;
}

// Anything saved before the stores were split still sits in KV under the same
// key. Reads fall back to it so a phone that was already in use keeps its
// deck, its learned preferences and its approvals; the next write moves them.
// The answer cache has its own namespace, so it can be emptied without
// touching what the app learned. KV is still read for anything cached before
// the split, and is used as the store when CACHE is not bound.
function cacheStore(env) {
  return env.CACHE || env.KV || null;
}

async function cacheGet(env, key) {
  const store = cacheStore(env);
  if (!store) return null;
  try {
    const hit = await store.get(key);
    if (hit) return hit;
  } catch (err) {}
  if (env.CACHE && env.KV) {
    try {
      return await env.KV.get(key);
    } catch (err) {}
  }
  return null;
}

async function readMoved(env, store, key) {
  try {
    const raw = await store.get(key);
    if (raw || !env.KV || env.KV === store) return raw;
    return await env.KV.get(key);
  } catch (err) {
    return null;
  }
}

// ---- truths -----------------------------------------------------------
// A truth is a record, not an answer: the question, the answer, how sure we
// are, what it rests on, who signed it off and when. A store that keeps only
// the answer and a number is a cache with a confidence label, which is what
// this replaces. Today it writes into cods' own ARCHIVE namespace under a
// "truth:" prefix; TRUTHS / AUDITS are bindings, not a rewrite.
function truthStore(env) {
  return env.TRUTHS || env.ARCHIVE || env.KV || null;
}
const TRUTH_INDEX_KEY = "truths:index";
const TRUTH_LIMIT = 500;
const TRUTH_MASTER_FLOOR = 0.9;

function cleanSources(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((s) => {
    const url = String((s && s.url) || "").slice(0, 500);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ title: String((s && s.title) || "").slice(0, 200), url });
  });
  return out.slice(0, 8);
}

// Confidence is earned, never asserted. Sources and a live search move it, and
// it is capped below the master floor: only an expert crosses that line.
function truthConfidence({ sources, searched }) {
  let c = 0.4 + 0.08 * Math.min((sources || []).length, 4);
  if (searched) c += 0.1;
  return Math.round(Math.min(0.85, c) * 100) / 100;
}

async function truthIndex(env, store) {
  const box = store || truthStore(env);
  if (!box) return [];
  try {
    const raw = await box.get(TRUTH_INDEX_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

async function indexTruth(env, store, rec) {
  const box = store || truthStore(env);
  if (!box) return;
  const list = await truthIndex(env, box);
  const rest = list.filter((r) => r && r.id !== rec.id);
  rest.unshift({
    id: rec.id,
    question: rec.question,
    status: rec.status,
    confidence: rec.confidence,
    sources: (rec.sources || []).length,
    seen: rec.seen || 1,
    updated: rec.updated,
  });
  await box.put(TRUTH_INDEX_KEY, JSON.stringify(rest.slice(0, TRUTH_LIMIT)));
}

async function saveTruth(env, { question, answer, sources, provider, model, preset, searched }) {
  const box = truthStore(env);
  const q = String(question || "").trim().slice(0, 600);
  if (!box || !q || !answer) return null;

  const id = "t_" + (await hashKey(normalized(q) + "|" + String(preset || model || ""))).slice(0, 16);
  const now = new Date().toISOString();
  const kept = cleanSources(sources);
  const confidence = truthConfidence({ sources: kept, searched });

  let rec = null;
  try {
    const raw = await box.get("truth:" + id);
    rec = raw ? JSON.parse(raw) : null;
  } catch (err) {
    rec = null;
  }

  if (rec) {
    // Asked again: updated in place, and the history keeps what it said before,
    // so a confidence that moves has a reason on the record.
    rec.history = (rec.history || [])
      .concat([{ at: now, status: rec.status, confidence: rec.confidence, by: rec.approver || null, action: "seen" }])
      .slice(-20);
    rec.answer = String(answer).slice(0, 4000);
    rec.sources = kept.length ? kept : rec.sources || [];
    const floor = rec.status === "master" ? TRUTH_MASTER_FLOOR : 0;
    rec.confidence = Math.round(Math.max(rec.confidence || 0, confidence, floor) * 100) / 100;
    rec.seen = (rec.seen || 1) + 1;
    rec.updated = now;
    rec.provider = provider || rec.provider || null;
    rec.model = model || rec.model || null;
    rec.preset = preset || rec.preset || null;
  } else {
    rec = {
      id,
      question: q,
      answer: String(answer).slice(0, 4000),
      confidence,
      sources: kept,
      status: "candidate",
      approver: null,
      note: null,
      provider: provider || null,
      model: model || null,
      preset: preset || null,
      searched: !!searched,
      seen: 1,
      created: now,
      updated: now,
      history: [],
    };
  }

  await box.put("truth:" + id, JSON.stringify(rec));
  await indexTruth(env, box, rec);
  if (env.AUDITS) {
    try {
      await env.AUDITS.put(
        "truth:" + id + ":" + Date.now(),
        JSON.stringify({ action: rec.seen > 1 ? "seen" : "candidate", id, confidence: rec.confidence, status: rec.status, at: now })
      );
    } catch (err) {}
  }
  return rec;
}

// Serving an answer from cache is still a sighting: the record counts it, so a
// truth that gets asked for every day does not look untouched.
async function touchTruth(env, id) {
  const box = truthStore(env);
  if (!box || !id) return null;
  try {
    const raw = await box.get("truth:" + id);
    const rec = raw ? JSON.parse(raw) : null;
    if (!rec) return null;
    rec.seen = (rec.seen || 1) + 1;
    rec.updated = new Date().toISOString();
    await box.put("truth:" + id, JSON.stringify(rec));
    await indexTruth(env, box, rec);
    return rec;
  } catch (err) {
    return null;
  }
}

// Only an expert moves the line. Without TRUTH_KEY set, nothing can be signed
// off: the public pages never carry that key.
function truthAdmin(env, request) {
  const key = String(env.TRUTH_KEY || "").trim();
  if (!key) return "TRUTH_KEY is not set, so no truth can be signed off yet";
  const given = String(request.headers.get("x-truth-key") || "");
  if (given.length !== key.length) return "wrong expert key";
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff ? "wrong expert key" : null;
}

async function promoteTruth(env, store, rec, body) {
  const now = new Date().toISOString();
  const by = String((body && body.by) || "expert").slice(0, 80);
  rec.history = (rec.history || [])
    .concat([{ at: now, status: rec.status, confidence: rec.confidence, by: rec.approver || null, action: "approve" }])
    .slice(-20);
  rec.status = "master";
  rec.approver = by;
  rec.approved_at = now;
  rec.confidence = Math.round(Math.max(Number(body && body.confidence) || 0, TRUTH_MASTER_FLOOR) * 100) / 100;
  if (body && body.note) rec.note = String(body.note).slice(0, 400);
  rec.updated = now;
  await store.put("truth:" + rec.id, JSON.stringify(rec));
  await indexTruth(env, store, rec);
  if (env.AUDITS) {
    try {
      await env.AUDITS.put(
        "truth:" + rec.id + ":approve:" + Date.now(),
        JSON.stringify({ action: "approve", id: rec.id, by, confidence: rec.confidence, at: now })
      );
    } catch (err) {}
  }
  return rec;
}

const THEMES = {
  default: { name: "default", primary: "#c41e3a", bg: "#101014", card: "#1c1c25", text: "#f2f2f6", line: "#2c2c38" },
  light: { name: "light", primary: "#c41e3a", bg: "#f3f3f7", card: "#ffffff", text: "#15151b", line: "#dcdce6" },
  forest: { name: "forest", primary: "#4caf7d", bg: "#0e1512", card: "#15201b", text: "#eaf3ee", line: "#243029" },
  ocean: { name: "ocean", primary: "#3d8bd4", bg: "#0b1017", card: "#121a24", text: "#e8f1fa", line: "#22303d" },
  ember: { name: "ember", primary: "#e0653a", bg: "#130f0c", card: "#1e1813", text: "#f7efe8", line: "#332a22" },
  mono: { name: "mono", primary: "#d0d0d8", bg: "#0d0d0f", card: "#17171b", text: "#f4f4f6", line: "#2a2a30" },
};

function cleanTheme(input) {
  if (!input || typeof input !== "object") return null;
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : null);
  const out = {
    name: String(input.name || "custom").slice(0, 24),
    primary: hex(input.primary),
    bg: hex(input.bg),
    card: hex(input.card),
    text: hex(input.text),
    line: hex(input.line),
  };
  if (!out.primary || !out.bg || !out.card || !out.text) return null;
  if (!out.line) out.line = out.card;
  return out;
}

function themeIntent(prompt) {
  return /\b(theme|colou?rs?|palette|dark mode|light mode)\b/i.test(String(prompt || ""));
}

function presetFor(text) {
  const t = String(text || "").toLowerCase();
  for (const key of Object.keys(THEMES)) {
    if (key !== "default" && t.indexOf(key) >= 0) return THEMES[key];
  }
  if (/\b(white|bright|day|light)\b/.test(t)) return THEMES.light;
  if (/\b(green|forest|nature)\b/.test(t)) return THEMES.forest;
  if (/\b(blue|ocean|cool|teal)\b/.test(t)) return THEMES.ocean;
  if (/\b(warm|orange|ember|sunset)\b/.test(t)) return THEMES.ember;
  if (/\b(grey|gray|mono|monochrome|black and white)\b/.test(t)) return THEMES.mono;
  return null;
}

// A look is not content, so the decision model is not asked here.
async function themeFor(env, prompt) {
  const preset = presetFor(prompt);
  if (preset) return preset;
  try {
    const r = await askText(
      env,
      [
        { role: "system", content: "Reply with six hex colours only, in this order: primary, background, card, text, border." },
        { role: "user", content: String(prompt || "").slice(0, 300) },
      ],
      { max_tokens: 100, temperature: 0.4 }
    );
    const hexes = String(r.text).match(/#[0-9a-f]{6}/gi) || [];
    if (hexes.length >= 4) {
      return cleanTheme({ name: "custom", primary: hexes[0], bg: hexes[1], card: hexes[2], text: hexes[3], line: hexes[4] || hexes[2] });
    }
  } catch (err) {}
  return null;
}

async function loadApproved(env) {
  const empty = { items: {} };
  const store = arcStore(env);
  if (!store) return empty;
  try {
    const raw = await readMoved(env, store, APPROVED_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) || {};
    return { items: parsed.items && typeof parsed.items === "object" ? parsed.items : {} };
  } catch (err) {
    return empty;
  }
}

async function saveApproved(env, store) {
  const arc = arcStore(env);
  if (!arc) return false;
  const entries = Object.entries(store.items || {}).sort(
    (a, b) => Date.parse(b[1].updated || 0) - Date.parse(a[1].updated || 0)
  );
  const kept = {};
  entries.slice(0, APPROVED_LIMIT).forEach(([k, v]) => {
    kept[k] = v;
  });
  await arc.put(APPROVED_KEY, JSON.stringify({ items: kept, updated: new Date().toISOString() }));
  return true;
}

// LTM is the only memory with no expiry, so a question asked months ago still
// answers itself even though the KV cache is long gone.
async function ltmKey(prompt) {
  return "q/" + (await hashKey(normalized(prompt))) + ".json";
}

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

async function archiveLog(env, entry) {
  const arc = arcStore(env);
  if (!arc) return false;
  try {
    const raw = await arc.get(ARCHIVE_LOG_KEY);
    const log = raw ? JSON.parse(raw) : [];
    const next = [entry].concat(Array.isArray(log) ? log : []).slice(0, 120);
    await arc.put(ARCHIVE_LOG_KEY, JSON.stringify(next));
    return true;
  } catch (err) {
    return false;
  }
}

async function approvedHash(prompt) {
  return "h" + (await hashKey("approved|" + normalized(prompt)));
}

async function approvedHit(env, prompt) {
  if (!arcStore(env)) return null;
  const store = await loadApproved(env);
  return store.items[await approvedHash(prompt)] || null;
}

// A separate admin Worker owns ranking when one is bound. Until then the
// main Worker keeps the store itself, so nothing waits on a second deploy.
async function adminProxy(env, request, path, raw) {
  if (!env.ADMIN || typeof env.ADMIN.fetch !== "function") return null;
  try {
    const res = await env.ADMIN.fetch("https://admin" + path, {
      method: request.method === "POST" ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: raw ? raw : undefined,
    });
    const text = await res.text();
    return new Response(text || "{}", {
      status: res.status || 200,
      headers: { "Content-Type": "application/json", "X-Admin-Worker": "1", ...cH },
    });
  } catch (err) {
    return json({ error: "admin worker unreachable: " + err.message }, 502);
  }
}

async function handleApprove(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const q = String(body.q || "").trim();
  if (!q) return json({ error: "Need the question" }, 400);
  const proxied = await adminProxy(env, request, "/approve", JSON.stringify(body));
  if (proxied) return proxied;
  if (!arcStore(env)) return json({ error: "No KV or ARCHIVE bound on this Worker" }, 503);
  const rank = body.rank === undefined ? 3 : Number(body.rank);
  if (!Number.isFinite(rank) || rank < 0 || rank > 5) return json({ error: "rank is 0 to 5" }, 400);

  const store = await loadApproved(env);
  const key = await approvedHash(q);
  if (rank === 0) {
    delete store.items[key];
  } else {
    const cards = (Array.isArray(body.cards) ? body.cards : [])
      .filter((c) => c && c.a)
      .slice(0, 4)
      .map((c) => ({ q: String(c.q || q).slice(0, 600), a: String(c.a).slice(0, 4000) }));
    if (!cards.length) return json({ error: "Nothing to approve" }, 400);
    store.items[key] = {
      q: q.slice(0, 400),
      cards,
      rank,
      at: (store.items[key] && store.items[key].at) || new Date().toISOString(),
      updated: new Date().toISOString(),
    };
  }
  await saveApproved(env, store);
  return json({ ok: true, approved: rank > 0, rank, count: Object.keys(store.items).length });
}

async function handleFeedback(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const action = String(body.action || "").trim();
  if (!action) return json({ error: "action is required" }, 400);

  const q = String(body.q || body.prompt || "").trim();
  const a = String(body.a || body.answer || "").trim();
  const decision = body.decision || null;
  const note = [
    "Feedback: " + action,
    "Domain: " + ((decision && decision.domain) || "unknown"),
    "Intent: " + ((decision && decision.intent) || "unknown"),
    "Question: " + q,
    "Card: " + String(a).slice(0, 2000),
  ].join("\n");

  // Feedback is the learning signal: each press moves a counter that the next
  // question reads back, so the system tightens on this person's preferences.
  const prefs = await loadPrefs(env);
  const domain = String((decision && decision.domain) || "unknown");
  prefs.actions[action] = (prefs.actions[action] || 0) + 1;
  const slot = prefs.domains[domain] || { n: 0 };
  slot.n = (slot.n || 0) + 1;
  slot[action] = (slot[action] || 0) + 1;
  prefs.domains[domain] = slot;
  if (action === "model") {
    const chosenModel = String(body.model || "").trim();
    if (chosenModel) prefs.model = chosenModel;
    else delete prefs.model;
  }
  prefs.events.push({ at: new Date().toISOString(), action, domain, q: q.slice(0, 120) });
  const remembered = await savePrefs(env, prefs);

  try {
    const indexed = await indexCard(env, {
      q: "feedback/" + action + ": " + q.slice(0, 120),
      a: note,
      decision,
      sources: null,
    });
    return json({ action, ok: true, indexed, learned: prefsHint(prefs), remembered });
  } catch (err) {
    return json({ action, ok: true, indexed: "not indexed: " + err.message, learned: prefsHint(prefs), remembered });
  }
}

// The model's side of the notes, OpenAI-compatible.
async function handleNotes(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;

  if (!Array.isArray(body.messages) || !body.messages.length) {
    return json({ error: "messages[] is required" }, 400);
  }
  try {
    return json(await notesChat(env, body.messages, body));
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

async function handleRoute(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json({ error: "No prompt" }, 400);

  const contextCards = Array.isArray(body.cards) ? body.cards.filter((c) => c && c.q) : [];
  let decision = null;
  let decisionError = null;
  try {
    decision = await decide(env, buildState(prompt, contextCards), body.questions);
  } catch (err) {
    decisionError = err.message;
  }

  const plan = planRoute(decision);
  let sources = null;
  let searchError = null;
  if (body.search && plan.search) {
    try {
      sources = await webSearch(env, prompt);
      if (!sources.length) {
        searchError = "web search returned no results";
      }
    } catch (err) {
      searchError = "web search failed: " + err.message;
    }
  }

  return json({
    decision,
    decision_error: decisionError,
    plan: {
      domain: plan.domain,
      label: plan.label,
      search: plan.search,
      care: plan.care,
      stable: plan.stable,
      ttl: plan.ttl,
    },
    sources,
    search_error: searchError,
  });
}

async function handleChat(request, env, emit) {
  const { body, error } = await readBody(request);
  if (error) return error;

  // stream:true answers with newline-delimited JSON: one line per step while
  // the work happens, then a final {type:"done"} carrying the usual payload.
  // The page shows those lines filling a card, so the wait is visible.
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

  const t0 = Date.now();
  const thinking = [];
  const step = (name, detail) => {
    const entry = { step: name, detail: detail == null ? "" : String(detail), ms: Date.now() - t0 };
    thinking.push(entry);
    if (emit) { try { emit({ type: "step", step: entry.step, detail: entry.detail, ms: entry.ms }); } catch (err) {} }
  };

  const prompt = String(body.prompt || "").trim();

  // What this question runs on. A pick is a preference, so it is also never
  // served from what another model remembered.
  const pick = await pickModel(env, body);
  let proxyWanted = pick.proxy === true;
  const pickLabel = pick.openrouter
    ? pick.preset
      ? "@preset/" + pick.preset
      : pick.model
    : pick.proxy
      ? "proxy" + (pick.preset ? ":" + pick.preset : "")
      : pick.cf || "";
  let pickError = "";
  if (!prompt) return json({ error: "No prompt" }, 400);

  // 0. Approved — a question this person has signed off on answers itself.
  if (body.use_approved !== false) {
    const approved = await approvedHit(env, prompt);
    if (approved) {
      step("approved", "signed off before, rank " + approved.rank);
      const first = approved.cards[0] || { a: "" };
      return json({
        prompt,
        answer: first.a,
        response: first.a,
        cards: approved.cards,
        provider: "approved",
        route: "approved",
        approved: true,
        rank: approved.rank,
        approved_at: approved.at,
        thinking,
        cached: true,
      });
    }
  }

  // 0b. Long term — the same question, however long ago it was asked.
  if (env.LTM && body.use_cache !== false && !proxyWanted && body.audit !== true) {
    const remembered = await ltmGet(env, prompt);
    if (remembered) {
      step("memory", "answered before, kept in long-term memory");
      return json({
        prompt,
        answer: remembered.answer,
        response: remembered.answer,
        cards: remembered.cards,
        provider: remembered.provider,
        route: "ltm",
        decision: remembered.decision || null,
        approved: false,
        cached: true,
        thinking,
      });
    }
  }

  const contextCards = Array.isArray(body.cards) ? body.cards.filter((c) => c && c.q) : [];
  const prefs = await loadPrefs(env);
  const learned = prefsHint(prefs);
  step("memory", learned ? learned : "nothing learned yet");
  const theme = themeIntent(prompt) ? await themeFor(env, prompt) : null;
  if (theme) step("theme", theme.name + " " + theme.primary);
  // Answers from earlier rounds ride along, so the next decision is made with
  // this person's actual intent rather than another guess.
  const said = Array.isArray(body.clarify) ? body.clarify.filter((c) => c && c.q) : [];
  const told = said.length ? contextCards.concat(said.map((c) => ({ q: c.q, a: c.a }))) : contextCards;
  const fitted = fitState({ prompt, told, learned, card: SHAPE_CARD });
  const state = fitted.state;
  const failures = [];

  // 1. Decide — clef-flash classifies the request.
  let decision = null;
  let decisionError = null;
  try {
    decision = await decide(env, state, body.questions);
    if (String(body.search || "").toLowerCase() === "yes") decision.needs_web = 0.95;
    if (String(body.search || "").toLowerCase() === "no") decision.needs_web = 0.02;

    // Ask while it is still unsure, and stop after CLARIFY_ROUNDS so the loop
    // stays a conversation rather than an interrogation.
    const asks = said.length < CLARIFY_ROUNDS ? clarifyQuestions(decision, said) : [];
    if (asks.length) {
      step("clarify", asks.length + (asks.length === 1 ? " question" : " questions"));
      return json({
        prompt,
        clarify: { round: said.length, max: CLARIFY_ROUNDS, questions: asks, said },
        decision: slimDecision(decision),
        answer: null,
        cards: null,
        thinking,
      });
    }
  } catch (err) {
    decisionError = err.message;
    failures.push("clef-flash: " + err.message);
    // 413 / 5021 is the window, not a broken model. Ask again with less rather
    // than routing blind, and say so in the trail.
    if (/context window|5021|too large|exceeded/i.test(err.message)) {
      step("state", "clef refused the full state, retried with the question alone");
      try {
        decision = await decide(env, "New message:\n" + prompt, body.questions);
        decisionError = null;
      } catch (again) {
        decisionError = again.message;
        failures.push("clef-flash retry: " + again.message);
      }
    }
  }
  if (decision && learned) decision.preferences = learned;
  step("decide", decision
    ? "domain " + decision.domain + " · intent " + decision.intent + " · depth " + decision.depth + (decision.needs_web != null ? " · web " + decision.needs_web : "") +
      (decision.shape ? " · shape " + decision.shape : "") +
      (fitted.trimmed ? " · trimmed " + fitted.dropped + (fitted.dropped === 1 ? " card" : " cards") + (fitted.promptCut ? ", prompt cut" : "") : "")
    : "clef-flash failed: " + decisionError);

  // 2. Cache — answered before?
  const key = await cacheKeyFor(prompt, contextCards, body, env);
  if (cacheStore(env) && body.use_cache !== false) {
    try {
      const cached = await cacheGet(env, key);
      if (cached) {
        const parsed = JSON.parse(cached);
        step("cache", "answered before, served from KV");
        parsed.cached = true;
        parsed.route = "cache";
        if (parsed.truth && parsed.truth.id) {
          const bumped = await touchTruth(env, parsed.truth.id);
          if (bumped) parsed.truth.seen = bumped.seen;
        }
        parsed.thinking = thinking;
        return json(parsed);
      }
    } catch (err) {}
  }

  // 2b. The notes. Cards already saved go to the human on the flipped card,
  //     and to the model as background. The model still writes the answer.
  let related = [];
  let relatedError = null;
  if (body.use_notes !== false) {
    try {
      related = await relatedNotes(env, prompt, Number(body.related_limit || 4));
    } catch (err) {
      relatedError = err.message;
    }
  }
  step("notes", related.length + " saved notes matched" + (relatedError ? " (notes failed)" : ""));

  const plan = planRoute(decision);

  if (body.decision_only) {
    return json({ decision, decision_error: decisionError, plan: { domain: plan.domain, search: plan.search, care: plan.care, stable: plan.stable } }, decision ? 200 : 502);
  }

  // 3. Search — only when the decision asks for live sources.
  let sources = [];
  let searchError = null;
  let searchVia = null;
  // The decision layer no longer gates search: a hit from the cache was
  // already served above, so everything else looks for sources before the
  // model speaks. use_web:false still turns it off for one request.
  if (body.use_web !== false) {
    try {
      const found = await webSearch(env, prompt);
      sources = found.sources || [];
      searchVia = found.via || null;
      if (found.errors && found.errors.length) {
        searchError = found.errors.join(" | ");
      }
    } catch (err) {
      searchError = "web search failed: " + err.message;
      failures.push("web search: " + err.message);
    }
  }
  step("search", sources.length
    ? sources.length + " sources via " + (searchVia || "web")
    : "no fresh sources" + (searchError ? ": " + String(searchError).slice(0, 90) : ""));

  // 4. Answer — grounded in whatever we have.
  const systemBits = [styleHint(decision), plan.pack.guidance, plan.care ? plan.pack.safety : "", learned]
    .filter(Boolean);
  if (plan.pack.principles && plan.pack.principles.length) {
    systemBits.push(plan.pack.principles.join(" "));
  }
  if (sources.length) {
    systemBits.push(
      "Use the numbered web sources below. Cite them as [n] where you rely on them, and ignore any that are irrelevant."
    );
  }

  const messages = [];
  if (systemBits.length) messages.push({ role: "system", content: systemBits.join("\n") });
  if (sources.length) {
    messages.push({
      role: "system",
      content:
        "Web sources:\n" +
        sources
          .map((s, i) => "[" + (i + 1) + "] " + s.title + " — " + s.url + "\n" + s.description)
          .join("\n\n"),
    });
  }
  if (contextCards.length) {
    messages.push({
      role: "system",
      content:
        "Earlier in this conversation:\n" +
        contextCards.map((c) => "User: " + c.q + "\nAssistant: " + (c.r || "")).join("\n\n"),
    });
  }
  if (related.length) {
    messages.push({
      role: "system",
      content:
        "Notes this system saved from earlier cards. Background only: write your own answer, and say when a note is what you are relying on.\n" +
        related.map((n, i) => "[" + (i + 1) + "] " + n.title + "\n" + n.text).join("\n\n"),
    });
  }
  messages.push({ role: "user", content: prompt });

  const route = sources.length ? "web → llm" : "llm";

  // 4b. Cards — a search with several results becomes several cards.
  const wanted = Number(body.cards_per_result || CARD_LIMIT);
  const picked = uniqueSources(sources).slice(0, wanted > 0 ? wanted : CARD_LIMIT);
  if (picked.length >= 2) {
    const built = await Promise.all(
      picked.map(async (s, i) => {
        const one = messages.concat([
          {
            role: "system",
            content:              "Write the card for source [" + (i + 1) + "] only: " + s.title + " — " + s.url +
              "\n" + s.description +
              "\nGive the principle or fact this source contributes about the question — the rule it supports, " +
              "stated so it carries to other cases. Not a summary of the document. Two to four sentences. " +
              "No preamble, and do not restate the question.",
          },
        ]);
        try {
          const r = await askText(env, one, Object.assign({}, body, { max_tokens: body.max_tokens || 700 }));
          return { text: r.text, provider: r.provider, trace: r.trace, source: { title: s.title, url: s.url } };
        } catch (err) {
          failures.push("source " + (i + 1) + ": " + err.message);
          return null;
        }
      })
    );
    const cards = built
      .filter(Boolean)
      .map((c) => ({ q: prompt, a: c.text, provider: c.provider, source: c.source, decision: slimDecision(decision) }));
    if (cards.length >= 2) {
      step("cards", cards.length + " cards, one per source");
      return finish(env, key, plan, {
        prompt,
        related,
      theme,
        thinking,
        relatedError,
        answer: cards[0].a,
        cards,
        provider: cards[0].provider,
        route,
        decision,
        sources,
        trace: cards[0].trace,
        searchError,
        searchVia,
      });
    }
  }

  // 5. Text: Workers AI models in order, then OpenRouter. Every answer walks
  //    out with cards, so the send never lands as one flat blob.
  const respond = async ({ answer, provider, trace }) => {
    step("write", provider);
    await noteAttempt(env, plan.domain, trace && trace[0] ? trace[0].model : null, true);
    let cards = [];
    try {
      cards = await synthesizeCards(env, prompt, answer, decision, wanted, body, failures);
    } catch (err) {
      failures.push("cards: " + err.message);
    }
    // A synthesized card has to look like every other card: q for the header,
    // a for the body, or the page renders three blanks.
    const shaped = cards
      .filter((c) => c && c.text)
      .map((c) => ({
        q: prompt,
        a: c.text,
        provider: c.provider,
        kind: c.kind,
        decision: slimDecision(decision),
      }));
    step("cards", (shaped.length || 1) + " card" + ((shaped.length || 1) === 1 ? "" : "s") + " written");
    return finish(env, key, plan, {
      prompt,
      pick: pickLabel ? { requested: pickLabel, error: pickError || null } : null,
      truth: !!(pick && pick.preset === "truth" && !pickError),
      longTerm: !proxyWanted,
      related,
      theme,
      thinking,
      relatedError,
      answer,
      cards: shaped,
      provider,
      route,
      decision,
      sources,
      trace,
      searchError,
      searchVia,
    });
  };

  const cfModels = unique(
    []
      .concat(
        Array.isArray(body.cf_models) ? body.cf_models : [],
        env.CF_TEXT_MODELS ? String(env.CF_TEXT_MODELS).split(",") : [],
        CF_TEXT_MODELS
      )
      .map((m) => String(m || "").trim())
      .filter(Boolean)
  );
  // Same models, ordered by what has actually answered in this domain before.
  const scores = await loadScores(env);
  cfModels.sort((a, b) => scoreOf(scores, plan.domain, b) - scoreOf(scores, plan.domain, a));
  // The proxy answers only when a request asks for it outright, with
  // { proxy: true } (or provider: "orproxy"), optionally naming a preset.
  // An explicit audit is its own thing, not a model answer.
  if (pick.audit && env.ORPROXY) {
    try {
      const audited = await auditCall(env, prompt, body);
      return respond({
        answer: audited.text,
        provider: "clef-flash → audit · truth",
        trace: [{ source: "orproxy", via: "/v1/audit", model: "truth" }],
      });
    } catch (err) {
      failures.push("audit: " + err.message);
    }
  }

  if (pick.cf) cfModels.unshift(pick.cf);

  if (pick.openrouter) {
    const target = pick.preset ? "@preset/" + pick.preset : pick.model;
    if (env.OPENROUTER_API_KEY) {
      try {
        const answer = await callOpenRouter(env, target, messages, body);
        return respond({
          answer,
          provider: "clef-flash → openrouter · " + target,
          trace: [{ source: "openrouter", model: target }],
        });
      } catch (err) {
        pickError = err.message;
        failures.push("openrouter " + target + ": " + err.message);
      }
    } else if (env.ORPROXY && pick.preset) {
      proxyWanted = true;
    } else {
      pickError = "OPENROUTER_API_KEY is not set, and a model id needs it";
      failures.push("openrouter: " + pickError);
    }
  }

  if (env.ORPROXY && proxyWanted) {
    try {
      const via = await orProxyCall(
        env,
        messages,
        pick.preset && !body.preset ? Object.assign({}, body, { preset: pick.preset }) : body
      );
      return respond({
        answer: via.text,
        provider: "clef-flash → orproxy",
        trace: [{ source: "orproxy", via: via.via, model: via.model }],
      });
    } catch (err) {
      pickError = err.message;
      failures.push("orproxy: " + err.message);
    }
  }

  if (env.AI) {
    for (const cfModel of cfModels) {
      try {
        const aiResponse = await env.AI.run(cfModel, {
          messages,
          max_tokens: body.max_tokens || 2000,
          temperature: body.temperature ?? 0.7,
        });
        const text = textFrom(aiResponse);
        if (text) {
          return respond({
            answer: text,
            provider: "clef-flash → " + cfModel,
            trace: [{ source: "workers-ai", model: cfModel }],
          });
        }
        failures.push(cfModel + ": empty response");
      } catch (err) {
        failures.push(cfModel + ": " + err.message);
        await noteAttempt(env, plan.domain, cfModel, false);
      }
    }
  }

  if (env.OPENROUTER_API_KEY) {
    const models = unique([body.model, env.OPENROUTER_MODEL, ...OR_MODELS].filter(Boolean));
    const orErrors = [];
    for (const model of models) {
      try {
        const answer = await callOpenRouter(env, model, messages, body);
        return respond({
          answer,
          provider: "clef-flash → openrouter",
          trace: [{ source: "openrouter", model }],
        });
      } catch (err) {
        orErrors.push(model + ": " + err.message);
        if (err.status && err.status !== 400 && err.status !== 404) break;
      }
    }
    failures.push("openrouter: " + orErrors.join(" | "));
  } else {
    failures.push("openrouter: OPENROUTER_API_KEY is not set on this Worker");
  }

  if (env.CF_CHAT_MODEL && env.AI) {
    try {
      const aiResponse = await env.AI.run(env.CF_CHAT_MODEL, {
        messages,
        max_tokens: body.max_tokens || 2000,
        temperature: body.temperature ?? 0.7,
      });
      const answer = textFrom(aiResponse);
      if (answer) {
        return respond({
          answer,
          provider: "clef-flash → workers-ai",
          trace: [{ source: "workers-ai", model: env.CF_CHAT_MODEL }],
        });
      }
      failures.push("workers-ai: empty response");
    } catch (err) {
      failures.push("workers-ai: " + err.message);
    }
  }

  return json(
    {
      error:
        "No text provider answered. " +
        failures.join(" | ") +
        " — bind ORPROXY, or set the key with: wrangler secret put OPENROUTER_API_KEY",
      failures,
      decision,
      sources,
      search_error: searchError,
    },
    502
  );
}

// Workers AI returns either a plain string, {response: "..."}, or a full
// OpenAI-shaped envelope {choices:[{message:{content}}]}. Cards need the text.
function textFrom(aiResponse) {
  if (aiResponse == null) return "";
  if (typeof aiResponse === "string") return aiResponse.trim();

  const inner = aiResponse.response ?? aiResponse.result ?? aiResponse;
  if (typeof inner === "string") return inner.trim();
  if (!inner || typeof inner !== "object") return "";

  const choice = Array.isArray(inner.choices) ? inner.choices[0] : null;
  if (choice) {
    const msg = choice.message || choice.delta || {};
    const content = msg.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => (typeof part === "string" ? part : (part && part.text) || ""))
        .join("");
      if (joined.trim()) return joined.trim();
    }
  }

  if (typeof inner.text === "string" && inner.text.trim()) return inner.text.trim();
  if (typeof inner.output_text === "string" && inner.output_text.trim()) return inner.output_text.trim();
  return "";
}

function uniqueSources(sources) {
  const seen = new Set();
  return (sources || []).filter((s) => {
    const url = String((s && s.url) || "");
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function slimDecision(decision) {
  if (!decision) return null;
  return {
    intent: decision.intent,
    domain: decision.domain,
    depth: decision.depth,
    tone: decision.tone,
    needs_web: decision.needs_web,
    sensitive: decision.sensitive,
    shape: decision.shape || null,
  };
}

// Cards never wait on search. Search hands over pages when it can; when it
// cannot, the model writes the cards from its own answer, in angles, so a send
// always lands two or three cards instead of one blob.
const CARD_ANGLES = [
  {
    kind: "principle",
    ask:
      "Write the governing principle: the rule that decides this case, stated so it carries to other cases. Two to four sentences. No preamble.",
  },
  {
    kind: "practice",
    ask:
      "Write the application card: the concrete move in order, with the terms, numbers or steps that belong to this domain. Two to four sentences. No preamble.",
  },
  {
    kind: "edge",
    ask:
      "Write the edge card: where this breaks, the mistake people actually make, or the trade-off that decides it. Two to four sentences. No preamble.",
  },
];

// A small model ignores "write a different angle" and repeats the answer's
// opening, which is how three cards become one card three times. Each card
// therefore gets only its own slice of the answer to work from.
function sentenceSplit(text) {
  const parts = String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return parts.map((s) => s.trim()).filter(Boolean);
}

function slicesFor(answer, count) {
  const sentences = sentenceSplit(answer);
  if (sentences.length < count * 2) return Array.from({ length: count }, () => String(answer || ""));
  const per = Math.ceil(sentences.length / count);
  return Array.from({ length: count }, (_, i) => sentences.slice(i * per, (i + 1) * per).join(" "));
}

async function synthesizeCards(env, prompt, answer, decision, wanted, body, failures) {
  const count = wanted > 0 ? Math.min(wanted, CARD_ANGLES.length) : CARD_LIMIT;
  const slices = slicesFor(answer, count);
  const built = await Promise.all(
    CARD_ANGLES.slice(0, count).map(async (angle, index) => {
      const messages = [
        {
          role: "system",
          content:
            "You write cards for a knowledge app. Each card stands alone and is about the domain itself, not about any document.\n" +
            (decision && decision.domain ? "Domain: " + decision.domain + "\n" : "") +
            (decision && decision.preferences ? decision.preferences + "\n" : "") +
            angle.ask,
        },
        {
          role: "system",
          content: "Your material for this card, and nothing else:\n" + String(slices[index] || answer || "").slice(0, 1600),
        },
        { role: "user", content: prompt },
      ];
      try {
        const r = await askText(env, messages, Object.assign({}, body, { max_tokens: 400 }));
        return { text: r.text, provider: r.provider, trace: r.trace, kind: angle.kind };
      } catch (err) {
        failures.push("card " + angle.kind + ": " + err.message);
        return null;
      }
    })
  );
  return built.filter(Boolean);
}

// One place that knows the text order: Workers AI models, OpenRouter, then
// CF_CHAT_MODEL. Throws with every failure when nothing answered.
async function askText(env, messages, body) {
  const failures = [];
  const settings = { max_tokens: body.max_tokens || 2000, temperature: body.temperature ?? 0.7 };

  const cfModels = unique(
    []
      .concat(
        Array.isArray(body.cf_models) ? body.cf_models : [],
        env.CF_TEXT_MODELS ? String(env.CF_TEXT_MODELS).split(",") : [],
        CF_TEXT_MODELS
      )
      .map((m) => String(m || "").trim())
      .filter(Boolean)
  );

  if (env.ORPROXY && (body.proxy === true || String(body.provider || "") === "orproxy")) {
    try {
      const via = await orProxyCall(env, messages, settings);
      return { text: via.text, provider: "clef-flash → orproxy", trace: [{ source: "orproxy", via: via.via, model: via.model }] };
    } catch (err) {
      failures.push("orproxy: " + err.message);
    }
  }

  if (env.AI) {
    for (const cfModel of cfModels) {
      try {
        const text = textFrom(await env.AI.run(cfModel, Object.assign({ messages }, settings)));
        if (text) return { text, provider: "clef-flash → " + cfModel, trace: [{ source: "workers-ai", model: cfModel }] };
        failures.push(cfModel + ": empty response");
      } catch (err) {
        failures.push(cfModel + ": " + err.message);
      }
    }
  }

  if (env.OPENROUTER_API_KEY) {
    const models = unique([body.model, env.OPENROUTER_MODEL, ...OR_MODELS].filter(Boolean));
    const orErrors = [];
    for (const model of models) {
      try {
        const text = await callOpenRouter(env, model, messages, body);
        return { text, provider: "clef-flash → openrouter", trace: [{ source: "openrouter", model }] };
      } catch (err) {
        orErrors.push(model + ": " + err.message);
        if (err.status && err.status !== 400 && err.status !== 404) break;
      }
    }
    failures.push("openrouter: " + orErrors.join(" | "));
  } else {
    failures.push("openrouter: OPENROUTER_API_KEY is not set on this Worker");
  }

  if (env.CF_CHAT_MODEL && env.AI) {
    try {
      const text = textFrom(await env.AI.run(env.CF_CHAT_MODEL, Object.assign({ messages }, settings)));
      if (text) return { text, provider: "clef-flash → workers-ai", trace: [{ source: "workers-ai", model: env.CF_CHAT_MODEL }] };
      failures.push("workers-ai: empty response");
    } catch (err) {
      failures.push("workers-ai: " + err.message);
    }
  }

  const err = new Error(failures.join(" | "));
  err.failures = failures;
  throw err;
}

function unique(list) {
  return Array.from(new Set(list));
}

async function finish(
  env,
  key,
  plan,
  { prompt, answer, provider, route, decision, sources, trace, searchError, searchVia, related, relatedError, cards, theme, thinking, longTerm, pick, truth }
) {
  const payload = {
    answer,
    response: answer,
    cards: cards && cards.length ? cards : null,
    provider,
    route,
    theme: theme || null,
    decision: decision
      ? {
          intent: decision.intent,
          domain: decision.domain,
          depth: decision.depth,
          tone: decision.tone,
          needs_web: decision.needs_web,
          sensitive: decision.sensitive,
        }
      : null,
    sources: sources && sources.length ? sources.map((s) => ({ title: s.title, url: s.url })) : null,
    search_error: searchError || null,
    search_via: searchVia || null,
    related: related && related.length ? related : null,
    related_error: relatedError || null,
    pick: pick || null,
    trace,
    thinking: thinking || null,
    cached: false,
  };

  // Write every card back, so the next question finds it as a note.
  if (cards && cards.length) {
    const listed = [];
    for (const c of cards) {
      try {
        listed.push(await indexCard(env, { q: c.q || prompt, a: c.a, decision, sources: c.source ? [c.source] : sources }));
      } catch (err) {
        listed.push("not indexed: " + err.message);
      }
    }
    payload.indexed = listed;
  } else {
    try {
      payload.indexed = await indexCard(env, { q: prompt, a: answer, decision, sources });
    } catch (err) {
      payload.indexed = "not indexed: " + err.message;
    }
  }

  // A truth answer is a candidate the moment it lands: it carries its sources,
  // its confidence and where it came from, and it becomes a master truth only
  // when an expert signs it off by id. Recorded before the payload is cached,
  // so a repeat served from cache still knows which truth it is repeating.
  if (truth && answer) {
    try {
      const rec = await saveTruth(env, {
        question: prompt,
        answer,
        sources,
        provider,
        model: pick && pick.requested,
        preset: "truth",
        searched: !!(sources && sources.length),
      });
      payload.truth = rec
        ? { id: rec.id, status: rec.status, confidence: rec.confidence, sources: (rec.sources || []).length, seen: rec.seen, approver: rec.approver || null }
        : null;
    } catch (err) {
      payload.truth = "not stored: " + err.message;
    }
  }

  if (cacheStore(env) && answer) {
    try {
      await cacheStore(env).put(key, JSON.stringify(payload), { expirationTtl: plan.ttl });
    } catch (err) {}
  }

  if (answer && longTerm !== false) {
    try {
      payload.long_term = await ltmPut(env, prompt, payload);
    } catch (err) {
      payload.long_term = "not kept: " + err.message;
    }
    await archiveLog(env, {
      t: new Date().toISOString(),
      q: String(prompt).slice(0, 200),
      provider,
      route,
      cards: (cards || []).length,
    });
  }
  return json(payload);
}

// The OpenRouter proxy (binding ORPROXY) is a fetch Worker: one POST to
// /api/generate with {messages, model, stream:false}. It prefixes whatever
// model it is given with "@preset/", so what it wants is a preset name on its
// own OpenRouter account, not a model slug — "truth" is the one that answers.
// Anything else 404s at OpenRouter, which is why the preset is the default.
let orProxyMode = null;
const OR_PROXY_PRESET = "truth";
const OR_PROXY_PATHS = ["/api/generate"];

// The proxy answers with an OpenAI envelope, but a different proxy (or a
// preset that streams anyway) could hand back plain text; take either.
function orProxyText(out) {
  if (typeof out === "string") {
    const raw = out.trim();
    if (!raw) return "";
    // A JSON body that carries no text is an empty answer, not an answer that
    // happens to look like JSON: the next provider should get its turn.
    if (raw.charAt(0) === "{" || raw.charAt(0) === "[") {
      try {
        return textFrom(JSON.parse(raw));
      } catch (err) {
        return "";
      }
    }
    return raw;
  }
  return textFrom(out);
}

async function orProxyCall(env, messages, body) {
  const binder = env.ORPROXY;
  if (!binder) throw new Error("ORPROXY is not bound");
  if (typeof binder.fetch !== "function") {
    const err = new Error("ORPROXY has no fetch handler");
    err.notes = ["fetch: not a method on the binding"];
    throw err;
  }

  // The proxy always asks OpenRouter for "@preset/<name>", so this is a preset
  // on the proxy's account, not a model slug. An explicit proxy request may
  // name one (body.preset, or body.model), and ORPROXY_PRESET sets the default.
  const preset =
    body.preset || body.orproxy_preset || (body.proxy === true && body.model) || env.ORPROXY_PRESET || OR_PROXY_PRESET;
  // A preset carries its own model and generation settings, so these are only
  // sent when the caller actually named one: a default max_tokens can exceed
  // what the preset's model accepts and the whole call fails.
  const settings = { messages, model: preset, stream: false };
  if (body.max_tokens != null) settings.max_tokens = body.max_tokens;
  if (body.temperature != null) settings.temperature = body.temperature;

  const notes = [];
  const paths = unique([orProxyMode || "", ...OR_PROXY_PATHS].filter(Boolean));
  for (const path of paths) {
    try {
      const res = await binder.fetch("https://orproxy" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const raw = await res.text();
      if (!res.ok) {
        notes.push(path + ": HTTP " + res.status + " " + raw.slice(0, 200));
        continue;
      }
      const text = orProxyText(raw);
      if (text) {
        orProxyMode = path;
        return { text, via: "fetch " + path, model: preset };
      }
      notes.push(path + ": empty reply");
    } catch (err) {
      notes.push(path + ": " + ((err && err.message) || String(err)));
    }
  }

  const err = new Error(notes.join(" | ") || "no route answered");
  err.notes = notes;
  throw err;
}

// The Truth Engine audit lives on the proxy: POST /v1/audit takes the subject
// as {content} and answers with the audit, either as one envelope or as a
// stream of server-sent events. Both are reduced to the text of the card.
async function auditCall(env, content, body) {
  const binder = env.ORPROXY;
  if (!binder || typeof binder.fetch !== "function") throw new Error("ORPROXY is not bound");
  const res = await binder.fetch("https://orproxy/v1/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      type: String(body.audit_type || "docket"),
      stream: false,
      audit_id: body.audit_id || undefined,
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + " " + raw.slice(0, 200));
  const text = sseText(raw);
  if (!text) throw new Error("the audit came back empty");
  return { text };
}

// An audit can arrive as an OpenAI envelope or as "data: {...}" lines; both
// carry the words in choices[0].message.content or choices[0].delta.content.
function sseText(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.charAt(0) === "{") {
    try {
      const fromJson = textFrom(JSON.parse(trimmed));
      if (fromJson) return fromJson;
    } catch (err) {}
  }
  let out = "";
  for (const line of trimmed.split("\n")) {
    if (line.indexOf("data:") !== 0) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      const choice = parsed.choices && parsed.choices[0];
      const piece = choice && (choice.delta ? choice.delta.content : choice.message ? choice.message.content : "");
      if (typeof piece === "string") out += piece;
    } catch (err) {}
  }
  return out.trim();
}

async function callOpenRouter(env, model, messages, body) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "X-Title": "kards",
    },
    body: JSON.stringify(
      Object.assign(
        {
          model,
          messages,
          max_tokens: body.max_tokens || 2000,
          temperature: body.temperature ?? 0.7,
        },
        // OpenRouter server tools ride in the request's own tools array
        // (openrouter:web_search, openrouter:datetime, openrouter:web_fetch),
        // with max_tool_calls bounding the agent loop. Passed through untouched.
        Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {},
        body.max_tool_calls != null ? { max_tool_calls: body.max_tool_calls } : {}
      )
    ),
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {}

  if (!res.ok) {
    const detail =
      (data && data.error && (data.error.message || data.error)) || text.slice(0, 300) || "no body";
    const err = new Error("HTTP " + res.status + " (" + model + "): " + detail);
    err.status = res.status;
    throw err;
  }

  const answer =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  if (!answer) {
    const err = new Error("empty completion from " + model);
    err.status = 502;
    throw err;
  }
  return answer;
}

async function hashKey(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
