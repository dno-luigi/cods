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
const OR_MODELS = ["openai/gpt-4o-mini"];
const WEB_THRESHOLD = 0.5;
const CARE_THRESHOLD = 0.5;
const STABLE_THRESHOLD = 0.55;
const TTL_STABLE = 604800; // 7 days
const TTL_VOLATILE = 3600; // 1 hour

// Text layer: Workers AI models in this order, then OpenRouter.
const CF_TEXT_MODELS = ["@cf/ibm-granite/granite-4.0-h-micro"];

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
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>kards</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#121212;color:#f5f5f5;font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;height:100dvh}
.top{padding:12px 16px;background:#1e1e1e;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;flex:0 0 auto}
.top h1{font-size:18px;color:#c41e3a}
.badge{background:#c41e3a;color:#fff;border-radius:12px;padding:2px 8px;font-size:12px}
.cards{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.card{background:#1e1e1e;border:1px solid #333;border-radius:12px;padding:16px;cursor:pointer}
.card:hover{border-color:#c41e3a}
.card-q{font-size:13px;color:#999;margin-bottom:8px;white-space:pre-wrap;word-break:break-word}
.card-a{font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;display:none}
.card.flipped .card-q{display:none}
.card.flipped .card-a{display:block}
.decision{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{font-size:10px;padding:2px 8px;border-radius:999px;background:#262626;border:1px solid #383838;color:#9a9a9a}
.chip.hi{border-color:#c41e3a;color:#e8a3ae}
.sources{display:flex;flex-direction:column;gap:3px;margin-top:8px;white-space:normal}
.source{font-size:11px;color:#8aa0c0;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.source:hover{text-decoration:underline}
.provider{font-size:10px;color:#666;margin-top:8px}
.input{padding:12px 16px;background:#1e1e1e;border-top:1px solid #333;display:flex;gap:8px;flex:0 0 auto}
.input input{flex:1;padding:12px;background:#121212;border:1px solid #333;border-radius:8px;color:#f5f5f5;font-size:15px;outline:none}
.input input:focus{border-color:#c41e3a}
.input button{padding:12px 20px;background:#c41e3a;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;min-width:74px}
.input button:disabled{opacity:.6;cursor:default}
.empty{text-align:center;padding:60px 20px;color:#666}
</style>
</head>
<body>
<div class="top"><h1>kards</h1><span class="badge" id="count">0</span></div>
<div class="cards" id="cards"></div>
<div class="input">
<input id="prompt" placeholder="Type a prompt..." autocomplete="off">
<button id="send">Send</button>
</div>
<script>
var CHAT_URL = 'https://cods.ai-n.workers.dev/chat';
var cards = [];
var el = {
  cards: document.getElementById('cards'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  count: document.getElementById('count')
};
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function meta(dec, sources) {
  var html = '';
  var tags = [];
  if (dec) {
    if (dec.intent) tags.push('intent: ' + dec.intent);
    if (dec.domain) tags.push('domain: ' + dec.domain);
    if (dec.depth != null) tags.push('depth: ' + dec.depth);
    if (dec.tone) tags.push('tone: ' + dec.tone);
    if (dec.needs_web != null) tags.push('web: ' + (dec.needs_web >= 0.5 ? 'yes' : 'no'));
    if (dec.sensitive != null && dec.sensitive >= 0.5) tags.push('care');
  }
  if (tags.length) {
    html += '<div class="decision">' + tags.map(function (t) {
      return '<span class="chip">' + esc(t) + '</span>';
    }).join('') + '</div>';
  }
  if (sources && sources.length) {
    html += '<div class="sources">' + sources.map(function (s, i) {
      return '<a class="source" href="' + esc(s.url) + '" target="_blank" rel="noopener">[' +
        (i + 1) + '] ' + esc(s.title) + '</a>';
    }).join('') + '</div>';
  }
  return html;
}
function render() {
  el.count.textContent = cards.length;
  if (!cards.length) {
    el.cards.innerHTML = '<div class="empty"><h3>No cards yet</h3><p>Type below to start</p></div>';
    return;
  }
  el.cards.innerHTML = cards.map(function (c) {
    return '<div class="card"><div class="card-q">' + esc(c.q) + '</div>' +
      '<div class="card-a">' + esc(c.a) + meta(c.decision, c.sources) + '</div>' +
      '<div class="provider">via ' + esc(c.provider) + '</div></div>';
  }).join('');
}
function send() {
  var p = el.prompt.value.trim();
  if (!p) return;
  el.prompt.value = '';
  el.send.disabled = true;
  el.send.textContent = '...';

  var card = { q: p, a: 'Thinking...', provider: 'pending', decision: null, sources: null };
  cards.push(card);
  render();

  fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: p,
      cards: cards.slice(0, -1).map(function (c) { return { q: c.q, r: c.a }; })
    })
  }).then(function (r) {
    return r.text().then(function (text) {
      var d = null;
      try { d = JSON.parse(text); } catch (e) { d = null; }
      if (!d) {
        card.a = 'Server returned ' + r.status + ': ' + text.slice(0, 300);
        card.provider = 'error';
      } else if (d.error) {
        card.a = d.error;
        card.provider = 'error ' + r.status;
        card.decision = d.decision || null;
      } else {
        card.a = d.answer || d.response || '(no response)';
        card.provider = (d.provider || 'openrouter') + (d.route ? ' · ' + d.route : '');
        card.decision = d.decision || null;
        card.sources = d.sources || null;
      }
    });
  }).catch(function (e) {
    card.a = 'Network error: ' + (e && e.message ? e.message : e);
    card.provider = 'error';
  }).then(function () {
    el.send.disabled = false;
    el.send.textContent = 'Send';
    render();
  });
}
el.send.onclick = send;
el.prompt.onkeydown = function (e) { if (e.key === 'Enter') send(); };
el.cards.onclick = function (e) {
  var c = e.target.closest ? e.target.closest('.card') : null;
  if (c) c.classList.toggle('flipped');
};
render();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
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
        gateway: env.AI_GATEWAY_ID || "default",
        text_models: CF_TEXT_MODELS,
        openrouter: !!env.OPENROUTER_API_KEY,
        chat_model: env.CF_CHAT_MODEL || null,
        kv: !!env.KV,
        domains: Object.keys(DOMAINS),
      });
    }

    if (url.pathname === "/route") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleRoute(request, env);
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

async function cacheKeyFor(prompt, contextCards, body, env) {
  const key =
    normalized(prompt) +
    "|" +
    JSON.stringify(contextCards.map((c) => normalized(c.q))) +
    "|" +
    (body.model || "") +
    "|" +
    (env.CF_CHAT_MODEL || "");
  return "ans:" + (await hashKey(key));
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

async function webSearch(env, query) {
  if (!env.AI || typeof env.AI.websearch !== "function") {
    throw new Error("websearch() is not available on this AI binding");
  }
  const res = await env.AI.websearch({
    gatewayId: env.AI_GATEWAY_ID || "default",
    query: String(query).slice(0, 1024),
    provider: env.SEARCH_PROVIDER || "ceramic",
    limit: Number(env.SEARCH_LIMIT || 5),
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

// ─── routing endpoints ────────────────────────────────────────────────────────

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
        failures.push("web search: " + searchError);
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

async function handleChat(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json({ error: "No prompt" }, 400);

  const contextCards = Array.isArray(body.cards) ? body.cards.filter((c) => c && c.q) : [];
  const state = buildState(prompt, contextCards);
  const failures = [];

  // 1. Decide — clef-flash classifies the request.
  let decision = null;
  let decisionError = null;
  try {
    decision = await decide(env, state, body.questions);
  } catch (err) {
    decisionError = err.message;
    failures.push("clef-flash: " + err.message);
  }

  // 2. Cache — answered before?
  const key = await cacheKeyFor(prompt, contextCards, body, env);
  if (env.KV && body.use_cache !== false) {
    try {
      const cached = await env.KV.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.cached = true;
        parsed.route = "cache";
        return json(parsed);
      }
    } catch (err) {}
  }

  const plan = planRoute(decision);

  if (body.decision_only) {
    return json({ decision, decision_error: decisionError, plan: { domain: plan.domain, search: plan.search, care: plan.care, stable: plan.stable } }, decision ? 200 : 502);
  }

  // 3. Search — only when the decision asks for live sources.
  let sources = [];
  let searchError = null;
  if (plan.search && body.use_web !== false) {
    try {
      sources = await webSearch(env, prompt);
      if (!sources.length) {
        searchError = "web search returned no results";
        failures.push("web search: " + searchError);
      }
    } catch (err) {
      searchError = "web search failed: " + err.message;
      failures.push("web search: " + err.message);
    }
  }

  // 4. Answer — grounded in whatever we have.
  const systemBits = [styleHint(decision), plan.pack.guidance, plan.care ? plan.pack.safety : ""]
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
  messages.push({ role: "user", content: prompt });

  const route = sources.length ? "web → llm" : "llm";

  // 5. Text: Workers AI models in order, then OpenRouter.
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
  if (env.AI) {
    for (const cfModel of cfModels) {
      try {
        const aiResponse = await env.AI.run(cfModel, {
          messages,
          max_tokens: body.max_tokens || 2000,
          temperature: body.temperature ?? 0.7,
        });
        const raw = aiResponse && (aiResponse.response ?? aiResponse);
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        if (text && text !== "null") {
          return finish(env, key, plan, {
            answer: text,
            provider: "clef-flash \u2192 " + cfModel,
            route,
            decision,
            sources,
            trace: [{ source: "workers-ai", model: cfModel }],
            searchError,
          });
        }
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
        const answer = await callOpenRouter(env, model, messages, body);
        return finish(env, key, plan, {
          answer,
          provider: "clef-flash → openrouter",
          route,
          decision,
          sources,
          trace: [{ source: "openrouter", model }],
          searchError,
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
      const raw = aiResponse && (aiResponse.response ?? aiResponse);
      const answer = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (answer && answer !== "null") {
        return finish(env, key, plan, {
          answer,
          provider: "clef-flash → workers-ai",
          route,
          decision,
          sources,
          trace: [{ source: "workers-ai", model: env.CF_CHAT_MODEL }],
          searchError,
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
        " — set the key with: wrangler secret put OPENROUTER_API_KEY",
      failures,
      decision,
      sources,
      search_error: searchError,
    },
    502
  );
}

function unique(list) {
  return Array.from(new Set(list));
}

async function finish(env, key, plan, { answer, provider, route, decision, sources, trace, searchError }) {
  const payload = {
    answer,
    response: answer,
    provider,
    route,
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
    trace,
    cached: false,
  };

  if (env.KV && answer) {
    try {
      await env.KV.put(key, JSON.stringify(payload), { expirationTtl: plan.ttl });
    } catch (err) {}
  }
  return json(payload);
}

async function callOpenRouter(env, model, messages, body) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "X-Title": "kards",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: body.max_tokens || 2000,
      temperature: body.temperature ?? 0.7,
    }),
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
