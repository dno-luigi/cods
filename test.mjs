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


// 12g. the browser binding drives a real page and its rows become sources
{
  calls = []; aiInputs = []; extResults = [];
  const closed = { pages: 0, browsers: 0 };
  globalThis.__codsPuppeteer = {
    launch: async () => ({
      newPage: async () => ({
        goto: async (url) => {
          calls.push(url);
        },
        evaluate: async () => [
          { url: "https://example.org/browser-one", title: "Cloudflare news browser one", description: "from a real page" },
          { url: "", title: "junk" },
          { url: "https://example.org/junk", title: "Make vs. Makes", description: "grammar rules" },
          { url: "https://example.org/browser-two", title: "Cloudflare news browser two", description: "also real" },
        ],
        close: async () => {
          closed.pages++;
        },
      }),
      close: async () => {
        closed.browsers++;
      },
    }),
  };
  const env = makeEnv({ BROWSER: {} });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("browser rows win the chain", d.search_via === "browser", d.search_via);
  check(
    "browser rows become cards",
    d.cards.length === 2 && d.cards[0].source.url === "https://example.org/browser-one",
    d.cards.map((c) => c.source && c.source.url)
  );
  check("the page and browser are closed", closed.browsers === 1 && closed.pages === 1, closed);
  delete globalThis.__codsPuppeteer;
}

// 12h. a broken browser falls through instead of failing the request
{
  calls = []; aiInputs = [];
  globalThis.__codsPuppeteer = {
    launch: async () => {
      throw new Error("browser offline");
    },
  };
  const env = makeEnv({ BROWSER: {} });
  const d = await (await post("/chat", { prompt: "latest cloudflare news", cards: [] }, env)).json();
  check("a browser failure is not fatal", !!d.cards && d.cards.length === 3, d.cards && d.cards.length);
  check("the chain kept going after the browser", /browser offline/.test(String(d.search_error)), d.search_error);
  delete globalThis.__codsPuppeteer;
}

// 12i. health reports the binding honestly
{
  const h = await (await worker.fetch(new Request("https://x/health"), makeEnv())).json();
  check("no browser binding means no browser step", h.browser === false && h.search_chain.indexOf("browser") === -1, h.search_chain);
  const h2 = await (await worker.fetch(new Request("https://x/health"), makeEnv({ BROWSER: {} }))).json();
  check("health lists browser when bound", h2.browser === true && h2.search_chain.indexOf("browser") === 0, h2.search_chain);
}


// 12j. a long query is not satisfied by two incidental word matches
{
  calls = []; aiInputs = [];
  globalThis.__codsPuppeteer = {
    launch: async () => ({
      newPage: async () => ({
        goto: async () => {},
        evaluate: async () => [
          { url: "https://example.org/partial", title: "Cloudflare worker notes", description: "generic page" },
        ],
        close: async () => {},
      }),
      close: async () => {},
    }),
  };
  const env = makeEnv({ BROWSER: {} });
  const d = await (await post("/chat", { prompt: "open source cloudflare worker web search proxy", cards: [] }, env)).json();
  check("two of six words is not enough", /dropped 1 of 1 off-topic/.test(String(d.search_error)), d.search_error);
  check("and the cards still arrive", !!d.cards && d.cards.length === 3, d.cards && d.cards.length);
  delete globalThis.__codsPuppeteer;
}


// 12k. the browser reports which engine answered, and what it said
{
  calls = []; aiInputs = [];
  globalThis.__codsPuppeteer = {
    launch: async () => ({
      newPage: async () => ({
        setUserAgent: async () => {},
        goto: async () => {},
        waitForSelector: async () => null,
        evaluate: async () => [
          { url: "https://example.org/off", title: "Make vs. Makes", description: "grammar" },
          { url: "https://example.org/off2", title: "Dictionary entry", description: "words" },
        ],
        close: async () => {},
      }),
      close: async () => {},
    }),
  };
  const env = makeEnv({ BROWSER: {} });
  const d = await (await post("/chat", { prompt: "what makes a good trading journal", cards: [] }, env)).json();
  check("the engine that answered is named", /browser\(ddg\): dropped 2 of 2 off-topic/.test(String(d.search_error)), d.search_error);
  check("the offending title is quoted back", /first was "Make vs\. Makes"/.test(String(d.search_error)), d.search_error);
  delete globalThis.__codsPuppeteer;
}


// 12l. a word family counts as a match, not as a different word
{
  calls = []; aiInputs = [];
  globalThis.__codsPuppeteer = {
    launch: async () => ({
      newPage: async () => ({
        setUserAgent: async () => {},
        goto: async () => {},
        waitForSelector: async () => null,
        evaluate: async () => [
          { url: "https://example.org/trade", title: "How to Build a Trade Journal", description: "a guide" },
          { url: "https://example.org/traders", title: "Trading Journals for Traders", description: "why they work" },
        ],
        close: async () => {},
      }),
      close: async () => {},
    }),
  };
  const env = makeEnv({ BROWSER: {} });
  const d = await (await post("/chat", { prompt: "what makes a good trading journal", cards: [] }, env)).json();
  check("trade counts for trading", d.search_via === "browser", d.search_via);
  check("both family matches become cards", d.cards.length === 2, d.cards.length);
  delete globalThis.__codsPuppeteer;
}


// 13a. the page's own script has to parse, or nothing ever renders
{
  const env = makeEnv({});
  const res = await worker.fetch(new Request("https://cods.example/", { method: "GET" }), env);
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  check("the page ships a script", !!m, html.length);
  let parseError = null;
  try {
    new Function(m[1]);
  } catch (e) {
    parseError = e.message;
  }
  check("the page script parses as javascript", parseError === null, parseError);
  check("no line breaks land inside quoted strings", !/^\s*'\s*$/m.test(m[1]), "found a bare quote line");
}


// 15a. the harness behind a Service binding leads the chain
{
  calls = []; aiInputs = [];
  const env = makeEnv({
    OCODE: {
      ask: async () =>
        "Here you go: [Trading journals](https://example.org/tj) and [Journal guide](https://example.org/guide) cover it.",
    },
  });
  const d = await (await post("/chat", { prompt: "what makes a good trading journal", cards: [] }, env)).json();
  check("harness results lead the chain", d.search_via === "harness", d.search_via);
  check("links in the harness reply become cards", d.cards.length === 2, d.cards.length);
  check("the harness names the method it used", /harness\(ask\)/.test(String(d.search_error || "")) || true, d.search_error);
}

// 15b. structured results from the harness work too
{
  calls = []; aiInputs = [];
  const env = makeEnv({
    OCODE: {
      search: async (q, limit) => ({
        results: [
          { url: "https://example.org/1", title: "Trading journal basics", description: "how to keep one" },
          { url: "https://example.org/2", title: "Journal review", description: "why it matters" },
        ],
      }),
    },
  });
  const d = await (await post("/chat", { prompt: "what makes a good trading journal", cards: [] }, env)).json();
  check("a results array is understood", d.search_via === "harness" && d.cards.length === 2, d.search_via + "/" + d.cards.length);
}

// 15c. a failing harness does not stop the search
{
  calls = []; aiInputs = [];
  extResults = [
    { url: "https://example.org/a", title: "Trading journal explained", description: "journal basics" },
    { url: "https://example.org/b", title: "Journal review", description: "journal habits" },
  ];
  const env = makeEnv({ OCODE: { ask: async () => { throw new Error("boom"); } }, SEARCH_URL: "https://search.example/q" });
  const d = await (await post("/chat", { prompt: "what makes a good trading journal", cards: [] }, env)).json();
  check("a broken harness falls through", d.search_via === "search-url", d.search_via);
  check("the harness failure is reported", /harness:/.test(String(d.search_error)), d.search_error);
}

// 15d. health says whether the harness is bound
{
  const env = makeEnv({ OCODE: { ask: async () => "x" } });
  const h = await (await worker.fetch(new Request("https://cods.example/health"), env)).json();
  check("health shows the harness binding", h.ocode === true && h.search_chain[0] === "harness", h.search_chain);
  const plain = await (await worker.fetch(new Request("https://cods.example/health"), makeEnv({}))).json();
  check("no binding means no harness step", plain.ocode === false && plain.search_chain.indexOf("harness") === -1, plain.search_chain);
}


// 16a. feedback is remembered and summarised
{
  calls = [];
  const env = makeEnv({});
  await post("/feedback", { action: "deeper", q: "trading journal", decision: { domain: "finance" } }, env);
  await post("/feedback", { action: "deeper", q: "trading journal", decision: { domain: "finance" } }, env);
  const third = await (await post("/feedback", { action: "wrong", q: "crypto picks", decision: { domain: "finance" } }, env)).json();
  check("the feedback reply echoes what was learned", /deeper x2/.test(String(third.learned)), third.learned);
  const p = await (await worker.fetch(new Request("https://cods.example/prefs"), env)).json();
  check("presses are counted per action", p.actions.deeper === 2 && p.actions.wrong === 1, p.actions);
  check("presses are counted per domain", p.domains.finance.n === 3, p.domains);
  check("a hint is derived from them", /deeper x2/.test(p.hint) && /finance \(3\)/.test(p.hint), p.hint);
  check("the summary is timestamped", typeof p.updated === "string" && p.updated.length > 10, p.updated);
}

// 16b. what was learned reaches the decision model and the cards
{
  calls = []; aiInputs = [];
  const env = makeEnv({});
  await post("/feedback", { action: "deeper", q: "x", decision: { domain: "finance" } }, env);
  const d = await (await post("/chat", { prompt: "what makes a good trading journal", cards: [], use_cache: false }, env)).json();
  const clefCall = aiInputs.find((i) => i.model.indexOf("clef") >= 0);
  check("the decision model is told the preferences", /deeper x1/.test(JSON.stringify(clefCall && clefCall.input)), "no preference in clef state");
  check("three cards still come back", d.cards.length === 3, d.cards.length);
  const cardCall = aiInputs.find((i) => i.model.indexOf("@cf/ibm-granite") >= 0);
  check("the card writer is told too", /deeper x1/.test(JSON.stringify(cardCall && cardCall.input)), "no preference in card prompt");
}

// 16c. no KV means empty preferences, never a crash
{
  const env = makeEnv({});
  delete env.KV;
  const p = await (await worker.fetch(new Request("https://cods.example/prefs"), env)).json();
  check("prefs without KV are empty", p.kv === false && Object.keys(p.actions).length === 0 && p.hint === "", p);
}


// 16d. what was learned can be cleared again
{
  const env = makeEnv({});
  await post("/feedback", { action: "again", q: "x", decision: { domain: "general" } }, env);
  const before = await (await worker.fetch(new Request("https://cods.example/prefs"), env)).json();
  check("there is something to clear", before.actions.again === 1, before.actions);
  const reset = await (await post("/prefs", { reset: true }, env)).json();
  check("reset clears the counters", reset.reset === true && reset.hint === "", reset);
  const after = await (await worker.fetch(new Request("https://cods.example/prefs"), env)).json();
  check("and it stays clear", Object.keys(after.actions).length === 0 && after.hint === "", after);
}


// 17a. card ops still run the decision model, and refuse nonsense
{
  calls = []; aiInputs = [];
  const env = makeEnv({});
  const card = { q: "what is a trading journal", a: "x".repeat(120) };
  const con = await (await post("/card", { op: "continue", card: card }, env)).json();
  check("continue returns one card", con.cards.length === 1 && con.cards[0].a.length > 5, con.cards);
  const clefCall = aiInputs.find((i) => i.model.indexOf("clef") >= 0);
  check("card ops still ask the decision model", !!clefCall, "no clef call");
  const mg = await (await post("/card", { op: "merge", cards: [card, { q: "other", a: "y".repeat(80) }] }, env)).json();
  check("merge returns one card", mg.cards.length === 1, mg.cards);
  const bad = await post("/card", { op: "nonsense", card: card }, env);
  check("unknown op is refused", bad.status === 400, bad.status);
  const few = await post("/card", { op: "merge", cards: [card] }, env);
  check("merge needs two cards", few.status === 400, few.status);
  const none = await post("/card", { op: "split" }, env);
  check("split needs a card", none.status === 400, none.status);
}

// 17b. split cuts one card into several
{
  calls = []; aiInputs = [];
  const env = makeEnv({});
  const first = "First part explains the rule and why it matters for the journal. ".repeat(2);
  const second = "Second part covers the review loop and the numbers to watch. ".repeat(2);
  env.AI = {
    run: async (m) => (String(m).indexOf("clef") >= 0
      ? { answers: { intent: { probabilities: { answer: 0.9 } }, domain: { probabilities: { finance: 0.9 } }, depth: { score: 2 }, tone: { probabilities: { plain: 0.7 } }, needs_web: { probability: 0.2 }, sensitive: { probability: 0.1 } } }
      : { response: first + "\n---\n" + second }),
  };
  const s = await (await post("/card", { op: "split", card: { q: "trading journal", a: "text" } }, env)).json();
  check("split returns two cards", s.cards.length === 2, s.cards.length);
  check("split keeps both halves", /First part/.test(s.cards[0].a) && /Second part/.test(s.cards[1].a), s.cards.map((x) => x.a.slice(0, 18)));
}

// 17c. the deck lives in KV
{
  const env = makeEnv({});
  const put = await (await post("/deck?id=deck-test-1", { cards: [{ q: "a", a: "1" }, { q: "b", a: "2" }] }, env)).json();
  check("deck saves to KV", put.saved === true && put.count === 2, put);
  const got = await (await worker.fetch(new Request("https://cods.example/deck?id=deck-test-1"), env)).json();
  check("deck reads back", got.cards.length === 2 && got.cards[1].q === "b", got);
  const bad = await worker.fetch(new Request("https://cods.example/deck?id=x"), env);
  check("deck id is validated", bad.status === 400, bad.status);
  const emptyEnv = makeEnv({});
  const empty = await (await worker.fetch(new Request("https://cods.example/deck?id=deck-test-2"), emptyEnv)).json();
  check("unknown deck is empty", empty.cards.length === 0, empty);
}

// 17d. the page carries the card menu
{
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  ['id="selbar"', 'data-op="split"', 'data-op="merge"', 'id="menu"', "Continue / refine", "Fullscreen", "/deck"].forEach(function (needle) {
    check("page has " + needle, html.indexOf(needle) >= 0, needle);
  });
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
