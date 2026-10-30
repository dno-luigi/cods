import worker from "./worker.js";

let calls = [];
let aiInputs = [];
let searchChunks = [];
let failSearch = null;
let uploaded = [];
let ddgBody = null;
let bingBody = null;
let extResults = [];

globalThis.fetch = function (url, opts) {
  calls.push(String(url));
  if (failSearch && String(url).endsWith("/search")) return Promise.reject(new Error(failSearch));
  if (String(url).endsWith("/search")) {
    return Promise.resolve(new Response(JSON.stringify({ success: true, result: { chunks: searchChunks } }), { status: 200 }));
  }
  if (String(url).endsWith("/chat/completions")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: "@cf/meta/llama-3.1-8b-instruct-fast",
          choices: [{ message: { role: "assistant", content: "notes answer" } }],
          chunks: searchChunks,
        }),
        { status: 200 }
      )
    );
  }
  if (String(url).includes("html.duckduckgo.com")) {
    return Promise.resolve(new Response(ddgBody || "<html></html>", { status: 200 }));
  }
  if (String(url).includes("bing.com/search")) {
    return Promise.resolve(new Response(bingBody || "<rss><channel></channel></rss>", { status: 200 }));
  }
  if (String(url).includes("api.github.com")) {
    return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
  }
  if (String(url).includes("search.example")) {
    return Promise.resolve(new Response(JSON.stringify({ results: extResults }), { status: 200 }));
  }
  if (String(url).includes("openrouter.ai")) {
    return Promise.resolve(new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 }));
  }
  return Promise.reject(new Error("unexpected fetch " + url));
};

function clef() {
  return {
    answers: {
      intent: { probabilities: { answer: 0.8, list: 0.2 } },
      domain: { probabilities: { news: 0.9, general: 0.1 } },
      tone: { probabilities: { plain: 0.7 } },
      depth: { score: 2 },
      needs_web: { probability: 0.9 },
      cache_ok: { probability: 0.2 },
      sensitive: { probability: 0.1 },
    },
  };
}

function makeEnv(extra) {
  const kv = new Map();
  return Object.assign(
    {
      AI: {
        run: async (model, input) => {
          aiInputs.push({ model: String(model), input });
          if (String(model).startsWith("@cf/cloudflare/clef")) return clef();
          if (String(model).startsWith("@cf/ibm-granite")) return { response: "granite answer" };
          throw new Error("no such model: " + model);
        },
      },
      KV: { get: async (k) => kv.get(k) || null, put: async (k, v) => kv.set(k, v) },
    },
    extra || {}
  );
}

async function post(path, body, env) {
  return worker.fetch(
    new Request("https://cods.ai-n.workers.dev" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env
  );
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

// 1. page + health
{
  calls = [];
  const html = await (await worker.fetch(new Request("https://x/"), makeEnv())).text();
  check("GET / serves the page", html.includes("<title>kards</title>"));
  check("flipped card has the notes block", html.includes('class="notes-h">Already in the notes'));
  check("flipped card has combine + extract", html.includes('data-act="combine"') && html.includes('data-act="extract"'));
  check("click handler wires the note buttons", html.includes(".relbtn"));

  const h = await (await worker.fetch(new Request("https://x/health"), makeEnv())).json();
  check("health names the search host", String(h.ai_search).includes("ebfc217f"));
  check("health names the instance", h.ai_search_instance === "NSM");
  check("health reports no index writer yet", h.index_writer === "none", h.index_writer);
  check("health keeps the domains", Array.isArray(h.domains) && h.domains.includes("medical"), h.domains);
}

// 2. /search = the human side
{
  calls = []; searchChunks = [{ id: "c1", score: 0.82, text: "Workers run isolates.", item: { key: "cards/abc.md" } }];
  const d = await (await post("/search", { query: "what are workers" }, makeEnv())).json();
  check("/search returns the notes", d.notes && d.notes.length === 1 && d.notes[0].score === 0.82, d);
  check("/search hits the public endpoint", calls[0].includes("ebfc217f") && calls[0].endsWith("/search"), calls);
  check("/search generates nothing", calls.length === 1, calls);
}

// 3. /chat = notes to both, LLM answers
{
  calls = []; aiInputs = []; failSearch = null;
  searchChunks = [{ id: "c1", score: 0.8, text: "Earlier note body", item: { key: "cards/abc.md" } }];
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, makeEnv())).json();
  check("the LLM answers, not the notes", d.answer === "granite answer", d);
  check("provider starts at clef", String(d.provider).startsWith("clef-flash"), d.provider);
  check("the human gets the notes", Array.isArray(d.related) && d.related.length === 1, d.related);
  check("note shape is title/text/score", Object.keys(d.related[0]).sort().join(",") === "score,text,title", d.related[0]);
  check("the model gets the notes as background", JSON.stringify(aiInputs).includes("Background only"));
  check("notes endpoint was not the answerer", !calls.some((u) => u.endsWith("/chat/completions")), calls);
  check("no OpenRouter detour", !calls.some((u) => u.includes("openrouter")), calls);
  check("write-back says why it could not index", String(d.indexed).startsWith("not indexed:"), d.indexed);
}

// 4. empty notes are not an error
{
  calls = []; searchChunks = [];
  const d = await (await post("/chat", { prompt: "anything", cards: [] }, makeEnv())).json();
  check("no notes -> no related", d.related === null, d.related);
  check("missing web search is reported", /websearch/i.test(String(d.search_error)), d.search_error);
}

// 5. a failing index is reported, not swallowed
{
  calls = []; failSearch = "connect ECONNREFUSED";
  const d = await (await post("/chat", { prompt: "anything", cards: [] }, makeEnv())).json();
  check("related failure surfaced", /ECONNREFUSED/.test(String(d.related_error)), d.related_error);
  check("answer still produced", d.answer === "granite answer", d);
  failSearch = null;
}

// 6. card write-back through the binding
{
  uploaded = [];
  const env = makeEnv({
    mainspace: {
      get: (name) => ({
        items: {
          upload: async (key, content) => { uploaded.push({ name, key, content }); return { id: "item-1", key }; },
        },
      }),
    },
  });
  const d = await (await post("/cards", { q: "what is kv", a: "a key value store" }, env)).json();
  check("/cards uploads through the binding", uploaded.length === 1, d);
  check("binding asks for the cards instance", uploaded[0] && uploaded[0].name === "NSM");
  check("note keeps the question", uploaded[0] && uploaded[0].content.includes("# what is kv"));
  check("note keeps the answer", uploaded[0] && uploaded[0].content.includes("a key value store"));
  check("note is under cards/", uploaded[0] && uploaded[0].key.startsWith("cards/"), uploaded[0] && uploaded[0].key);
  check("/cards reports indexed", String(d.results[0].indexed).startsWith("indexed"), d.results[0]);

  const h = await (await worker.fetch(new Request("https://x/health"), env)).json();
  check("health now shows the binding", h.index_writer === "binding", h.index_writer);
}

// 7. the model's side: /notes -> /chat/completions
{
  calls = []; searchChunks = [];
  const d = await (await post("/notes", { messages: [{ role: "user", content: "what do you know" }] }, makeEnv())).json();
  check("/notes returns the completion", d.choices && d.choices[0].message.content === "notes answer", d);
  check("/notes uses /chat/completions", calls.some((u) => u.endsWith("/chat/completions")), calls);
  const bad = await post("/notes", {}, makeEnv());
  check("/notes needs messages", bad.status === 400);
}

// 8. /route with an empty search no longer throws
{
  calls = []; searchChunks = [];
  const res = await post("/route", { prompt: "latest news", search: true }, makeEnv());
  const d = await res.json();
  check("/route survives an empty search", res.status === 200, d);
  check("/route reports the miss", d.sources === null && typeof d.search_error === "string", d);
}

// 9. method guards
{
  const env = makeEnv();
  for (const path of ["/search", "/cards", "/notes", "/chat", "/feedback"]) {
    const res = await worker.fetch(new Request("https://x" + path), env);
    check("GET " + path + " -> 405", res.status === 405, res.status);
  }
}

// 10. Workers AI answers with a full OpenAI envelope: the card must show the text
{
  calls = []; searchChunks = [];
  const env = makeEnv();
  env.AI.run = async (model) => {
    if (String(model).startsWith("@cf/cloudflare/clef")) return clef();
    if (String(model).startsWith("@cf/ibm-granite"))
      return {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: String(model),
        choices: [{ index: 0, message: { role: "assistant", content: "The calculation 2+2 equals 4." } }],
        usage: { total_tokens: 40 },
      };
    throw new Error("no such model: " + model);
  };
  const d = await (await post("/chat", { prompt: "what is 2+2", cards: [] }, env)).json();
  check("envelope unwrapped to text", d.answer === "The calculation 2+2 equals 4.", d.answer);
  check("no JSON blob on the card", !String(d.answer).includes("chat.completion"), d.answer);
  check("the note it saved is text too", !String(d.indexed).includes("chat.completion"));

  const env2 = makeEnv(); // fresh KV: the first answer is cached under this prompt
  env2.AI.run = async (model) => {
    if (String(model).startsWith("@cf/cloudflare/clef")) return clef();
    if (String(model).startsWith("@cf/ibm-granite"))
      return { choices: [{ message: { content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] } }] };
    throw new Error("no such model: " + model);
  };
  const parts = await (await post("/chat", { prompt: "what is 2+2", cards: [] }, env2)).json();
  check("content parts joined", parts.answer === "part one part two", parts.answer);
}

// 11. a search with several results fills the grid with one card each
{
  calls = []; aiInputs = []; searchChunks = [];
  const env = makeEnv();
  env.AI.websearch = async () => ({
    ok: true,
    json: async () => ({
      items: [
        { url: "https://one.example/a", title: "Source one", description: "first description" },
        { url: "https://two.example/b", title: "Source two", description: "second description" },
        { url: "https://one.example/a", title: "Source one again", description: "duplicate" },
      ],
    }),
  });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("two results become two cards", d.cards && d.cards.length === 2, d.cards && d.cards.length);
  check("duplicate url dropped", new Set(d.cards.map((c) => c.source.url)).size === d.cards.length, d.cards.map((c) => c.source.url));
  check("each card carries its source", d.cards.every((c) => c.source && c.source.url), d.cards);
  check("each card carries the decision", d.cards.every((c) => c.decision && c.decision.domain === "news"), d.cards[0].decision);
  check("answer is the first card", d.answer === d.cards[0].a, d.answer);
  check("each card was written from its own source",
    aiInputs.some((x) => JSON.stringify(x.input).includes("Source one")) &&
    aiInputs.some((x) => JSON.stringify(x.input).includes("Source two")),
    aiInputs.length);
  check("three model calls: one per card, no extra", aiInputs.filter((x) => String(x.model).startsWith("@cf/ibm-granite")).length === 2, aiInputs.map((x) => x.model));
}

// 12. one result stays one card
{
  const env = makeEnv();
  env.AI.websearch = async () => ({ ok: true, json: async () => ({ items: [{ url: "https://only.example", title: "Only", description: "single" }] }) });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("one result still fills the grid", Array.isArray(d.cards) && d.cards.length === 3, d.cards && d.cards.length);
  check("each synthesized card is its own angle", new Set(d.cards.map((c) => c.kind)).size === 3, d.cards.map((c) => c.kind));
  check("synthesized cards claim no source", d.cards.every((c) => !c.source), d.cards);
  check("synthesized cards carry their text", d.cards.every((c) => c.q === "latest cloudflare news" && c.a === "granite answer"), d.cards.map((c) => c.a));
  check("one result -> the plain answer", d.answer === "granite answer", d.answer);
}

// 12b. a 402 from Cloudflare's web search no longer starves the cards
{
  calls = []; aiInputs = [];
  ddgBody = [
    '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgeo.example%2Fa">Geothermal basics</a><a class="result__snippet">heat from the ground</a></div>',
    '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgeo.example%2Fb">Geothermal limits</a><a class="result__snippet">depth decides the cost</a></div>',
  ].join("");
  const env = makeEnv();
  env.AI.websearch = async () => ({ ok: false, status: 402 });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("402 falls through to a keyless provider", d.search_via === "duckduckgo", d.search_via);
  check("keyless sources become cards", d.cards && d.cards.length === 2, d.cards && d.cards.length);
  check("a keyless card keeps its url", d.cards && d.cards[0].source.url === "https://geo.example/a", d.cards && d.cards[0].source);
  check("the 402 is still reported", String(d.search_error || "").includes("402"), d.search_error);
  ddgBody = null;
}

// 13. feedback is kept as a note
{
  uploaded = [];
  const env = makeEnv({
    mainspace: {
      get: (name) => ({
        items: {
          upload: async (key, content) => { uploaded.push({ name, key, content }); return { key }; },
        },
      }),
    },
  });
  const d = await (await post("/feedback", { action: "deeper", q: "what is kv", a: "a store", decision: { domain: "code", intent: "answer" } }, env)).json();
  check("feedback reports ok", d.ok === true && d.action === "deeper", d);
  check("feedback lands in the index", uploaded.length === 1, d);
  check("feedback note names the action", uploaded[0].content.includes("Feedback: deeper"), uploaded[0].content);
  check("feedback note names the domain", uploaded[0].content.includes("Domain: code"), uploaded[0].content);
  const bad = await post("/feedback", {}, env);
  check("feedback needs an action", bad.status === 400);
}


// 12c. a search worker he deploys himself wins when SEARCH_URL is set
{
  calls = []; aiInputs = [];
  extResults = [
    { title: "Self hosted one", url: "https://ext.example/1", description: "first hit" },
    { title: "Self hosted two", url: "https://ext.example/2", description: "second hit" },
  ];
  const env = makeEnv({ SEARCH_URL: "https://search.example/api?format=json" });
  env.AI.websearch = async () => ({ ok: false, status: 402 });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("SEARCH_URL is asked first", d.search_via === "search-url", d.search_via);
  check("his own search fills the grid", d.cards && d.cards.length === 2, d.cards && d.cards.length);
  check("his own search gets the query", calls.some((u) => u.indexOf("search.example") >= 0 && u.indexOf("q=") >= 0), calls);
  extResults = [];
}

// 12d. bing rss carries the search when cloudflare 402s
{
  calls = []; aiInputs = [];
  bingBody = '<rss><channel>' +
    '<item><title>Cloudflare news one</title><link>https://bing.example/a</link><description>alpha</description></item>' +
    '<item><title>Cloudflare news two</title><link>https://bing.example/b</link><description>beta</description></item>' +
    '</channel></rss>';
  const env = makeEnv({ SEARCH_BING: "1" });
  env.AI.websearch = async () => ({ ok: false, status: 402 });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("402 falls to bing rss when it is switched on", d.search_via === "bing", d.search_via);
  check("bing rss items become cards", d.cards && d.cards.length === 2 && d.cards[0].source.url === "https://bing.example/a", d.cards && d.cards.length);
  bingBody = null;
}


// 12e. searchno longer waits for clef's permission, and cards never echo the prompt
{
  calls = []; aiInputs = [];
  const env = makeEnv();
  env.AI.run = async (model, input) => {
    aiInputs.push({ model: String(model), input });
    if (String(model).startsWith("@cf/cloudflare/clef")) {
      const c = clef();
      c.answers.needs_web = { probability: 0.05 };
      return c;
    }
    if (String(model).startsWith("@cf/ibm-granite")) return { response: "granite answer" };
    throw new Error("no such model: " + model);
  };
  env.AI.websearch = async () => ({
    ok: true,
    json: async () => ({
      items: [
        { url: "https://a.example/1", title: "One", description: "first" },
        { url: "https://a.example/2", title: "Two", description: "second" },
      ],
    }),
  });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("search runs even when clef says no web", d.search_via === "cloudflare", d.search_via);
  check("those sources become cards", d.cards && d.cards.length === 2, d.cards && d.cards.length);
  check("no card echoes the instruction", d.cards.every((c) => !/never open with/i.test(String(c.a))), d.cards.map((c) => c.a));
}


// 12f. bing stays out of the chain unless asked for
{
  const h = await (await worker.fetch(new Request("https://x/health"), makeEnv())).json();
  check("bing is opt-in", h.search_chain.indexOf("bing") === -1 && h.search_chain.indexOf("duckduckgo") >= 0, h.search_chain);
  const h2 = await (await worker.fetch(new Request("https://x/health"), makeEnv({ SEARCH_BING: "1" }))).json();
  check("bing comes back when asked", h2.search_chain.indexOf("bing") >= 0, h2.search_chain);
  const h3 = await (await worker.fetch(new Request("https://x/health"), makeEnv({ SEARCH_URL: "https://s.example/q" }))).json();
  check("a self hosted search leads the chain", h3.search_chain[0] === "search-url", h3.search_chain);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
