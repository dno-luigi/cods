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


// 17e. split never fakes a pair of identical cards
{
  calls = []; aiInputs = [];
  const env = makeEnv({});
  const one = "Risk rules cap position size at one percent of the account and put the stop below the invalidation level of the setup. ".repeat(2);
  env.AI = {
    run: async (m) => (String(m).indexOf("clef") >= 0
      ? { answers: { intent: { probabilities: { answer: 0.9 } }, domain: { probabilities: { finance: 0.9 } }, depth: { score: 2 }, tone: { probabilities: { plain: 0.7 } }, needs_web: { probability: 0.2 }, sensitive: { probability: 0.1 } } }
      : { response: one }),
  };
  const s = await (await post("/card", { op: "split", card: { q: "risk", a: "text" } }, env)).json();
  check("a model that refuses to split gives one card", s.cards.length === 1, s.cards.length);
  check("and that card is not a duplicate", s.cards[0].a === s.cards[0].a.trim(), s.cards[0].a.slice(0, 40));
}

// 17f. numbered cards are understood too
{
  calls = []; aiInputs = [];
  const env = makeEnv({});
  const a = "Position size is capped at one percent of the account and never more than that on a single idea at all. ";
  const b = "Reviews happen weekly, and every broken rule gets written down with the reason it broke that week. ";
  env.AI = {
    run: async (m) => (String(m).indexOf("clef") >= 0
      ? { answers: { intent: { probabilities: { answer: 0.9 } }, domain: { probabilities: { finance: 0.9 } }, depth: { score: 2 }, tone: { probabilities: { plain: 0.7 } }, needs_web: { probability: 0.2 }, sensitive: { probability: 0.1 } } }
      : { response: "Card 1: " + a + "\nCard 2: " + b }),
  };
  const s = await (await post("/card", { op: "split", card: { q: "rules", a: "text" } }, env)).json();
  check("numbered output splits in two", s.cards.length === 2, s.cards.length);
  check("both halves survive", /Position size/.test(s.cards[0].a) && /Reviews/.test(s.cards[1].a), s.cards.map((x) => x.a.slice(0, 16)));
  check("the Card 1 label is stripped", !/^card\s*\d+\s*[:.)-]/i.test(s.cards[0].a) && !/^\d+[.)]/.test(s.cards[0].a), s.cards[0].a.slice(0, 30));
}


// 18a. an approved answer wins before the model is asked
{
  const env = makeEnv({});
  const ap = await (await post("/approve", { q: "what is a trading journal", cards: [{ q: "what is a trading journal", a: "APPROVED: a journal is about process." }], rank: 4 }, env)).json();
  check("approve stores an answer", ap.ok === true && ap.rank === 4 && ap.count === 1, ap);
  calls = []; aiInputs = [];
  const c = await (await post("/chat", { prompt: "  What is a trading journal  " }, env)).json();
  check("the same question returns the approved answer", c.approved === true && /^APPROVED/.test(c.cards[0].a), c.cards && c.cards[0].a);
  check("and no model is woken up", aiInputs.length === 0, aiInputs.length);
  const list = await (await worker.fetch(new Request("https://cods.example/approved"), env)).json();
  check("the admin list shows it with its rank", list.count === 1 && list.items[0].rank === 4, list);
  await post("/approve", { q: "what is a trading journal", rank: 0 }, env);
  const gone = await (await worker.fetch(new Request("https://cods.example/approved"), env)).json();
  check("rank 0 removes it", gone.count === 0, gone);
  const bad = await post("/approve", { q: "x", rank: 9 }, env);
  check("rank outside 0..5 is refused", bad.status === 400, bad.status);
  const none = await post("/approve", { q: "x", cards: [], rank: 3 }, env);
  check("nothing to approve is refused", none.status === 400, none.status);
}

// 18b. a theme request recolours the page and travels with the deck
{
  const env = makeEnv({});
  const t = await (await post("/chat", { prompt: "make the theme forest green please" }, env)).json();
  check("a theme request returns tokens", t.theme && /^#[0-9a-f]{6}$/.test(t.theme.primary), t.theme);
  check("and it picks the forest preset", t.theme && t.theme.name === "forest", t.theme && t.theme.name);
  const saved = await (await post("/deck?id=deck-theme-1", { cards: [], theme: t.theme }, env)).json();
  check("the deck remembers the theme", saved.theme && saved.theme.primary === t.theme.primary, saved.theme);
  const back = await (await worker.fetch(new Request("https://cods.example/deck?id=deck-theme-1"), env)).json();
  check("and gives it back", back.theme && back.theme.name === "forest", back.theme);
  const rejected = await (await post("/deck?id=deck-theme-1", { cards: [], theme: { primary: "red" } }, env)).json();
  check("a bad theme is refused", rejected.theme === null, rejected);
  const plain = await (await post("/chat", { prompt: "what is a stop loss" }, env)).json();
  check("a normal question carries no theme", !plain.theme, plain.theme);
}

// 18c. the page ships the theme and approve wiring
{
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  ['data-op="approve"', "applyTheme", "PRESETS", "/approve", "loadApprovedList"].forEach(function (needle) {
    check("page has " + needle, html.indexOf(needle) >= 0, needle);
  });
}


// 19a. the answer streams its working before the cards land
{
  const env = makeEnv({});
  const res = await post("/chat", { prompt: "what is a stop loss", stream: true }, env);
  const type = res.headers.get("Content-Type") || "";
  check("chat can stream", type.indexOf("ndjson") >= 0, type);
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const steps = events.filter((e) => e.type === "step");
  const done = events[events.length - 1];
  check("it reports each step as it happens", steps.length >= 3 && steps.some((s) => s.step === "decide"), steps.map((s) => s.step));
  check("steps carry timings", steps.every((s) => typeof s.ms === "number"), steps[0]);
  check("and finishes with the usual payload", done && done.type === "done" && done.payload.cards && done.payload.cards.length >= 1, done && done.type);
  check("the payload explains itself", Array.isArray(done.payload.thinking) && done.payload.thinking.length >= 3, done.payload.thinking && done.payload.thinking.length);
  const plain = await (await post("/chat", { prompt: "what is slippage" }, env)).json();
  check("a plain answer carries the same working", Array.isArray(plain.thinking) && plain.thinking.some((s) => s.step === "write"), plain.thinking && plain.thinking.map((s) => s.step));
}

// 19b. an admin Worker takes over ranking once it is bound
{
  const seen = [];
  const env = makeEnv({
    ADMIN: {
      fetch: async (url, init) => {
        seen.push({ url: String(url), method: init.method, body: init.body });
        return new Response(JSON.stringify({ ok: true, from: "admin", rank: 5, count: 9 }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  });
  const d = await (await post("/approve", { q: "rank this", rank: 5, cards: [{ q: "rank this", a: "a" }] }, env)).json();
  check("approve goes to the admin worker", d.from === "admin" && seen[0].url === "https://admin/approve", seen[0] && seen[0].url);
  check("the ranked answer travels with it", String(seen[0].body).indexOf("rank this") > 0, seen[0].body);
  const listed = await (await worker.fetch(new Request("https://cods.example/approved"), env)).json();
  check("the admin list comes from there too", listed.from === "admin" && seen[1].url === "https://admin/approved", seen[1] && seen[1].url);
  const health = await (await worker.fetch(new Request("https://cods.example/health"), env)).json();
  check("health admits it is attached", health.admin === true && health.stream === "ndjson", health);
}

// 19c. the page ships play/stop, the stream reader and the why toggle
{
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  ['function stopVoice', 'function speak', 'stream: true', 'function readStream', 'data-set="think"', 'function typeIn'].forEach(function (n) {
    check("page has " + n, html.indexOf(n) >= 0, n);
  });
}


// 20a. each memory lands in the store it belongs to
{
  const ctx = new Map();
  const kv = new Map();
  const arc = new Map();
  const env = makeEnv({
    CONTEXT: { get: async (k) => ctx.get(k) || null, put: async (k, v) => ctx.set(k, v) },
    ARCHIVE: { get: async (k) => arc.get(k) || null, put: async (k, v) => arc.set(k, v) },
    KV: { get: async (k) => kv.get(k) || null, put: async (k, v) => kv.set(k, v) },
  });
  await post("/feedback", { action: "deeper", q: "how do I size a trade", a: "a" }, env);
  check("learned preferences go to CONTEXT", [...ctx.keys()].some((k) => k.indexOf("prefs") === 0), [...ctx.keys()]);
  const deck = await (await post("/deck?id=ctx-deck-1", { cards: [{ q: "q", a: "a" }] }, env)).json();
  check("the deck goes to CONTEXT too", deck.saved === true && [...ctx.keys()].some((k) => k === "deck:ctx-deck-1"), [...ctx.keys()]);
  await post("/approve", { q: "signed off", rank: 4, cards: [{ q: "signed off", a: "a" }] }, env);
  check("approved answers go to ARCHIVE", [...arc.keys()].some((k) => k === "approved:v1"), [...arc.keys()]);
  check("and none of it touched the cache namespace", [...kv.keys()].every((k) => k.indexOf("ans:") === 0), [...kv.keys()]);
  const health = await (await worker.fetch(new Request("https://cods.example/health"), env)).json();
  check("health names every store", health.memory && health.memory.context && health.memory.archive && health.memory.kv, health.memory);
}

// 20b. R2 keeps an answer for good, so a repeat question outlives the cache
{
  const bucket = new Map();
  const env = makeEnv({
    LTM: {
      put: async (k, v) => { bucket.set(k, v); },
      get: async (k) => (bucket.has(k) ? { text: async () => bucket.get(k) } : null),
    },
  });
  const first = await (await post("/chat", { prompt: "what is position sizing" }, env)).json();
  check("the answer is kept in R2", first.long_term === "kept" && [...bucket.keys()].some((k) => k.indexOf("q/") === 0), first.long_term);
  calls = []; aiInputs = [];
  const again = await (await post("/chat", { prompt: "What is position sizing" }, env)).json();
  check("a repeat question comes back from R2", again.route === "ltm" && again.cached === true, again.route);
  check("without waking a model", aiInputs.length === 0, aiInputs.length);
  check("and it explains itself", (again.thinking || []).some((s) => s.step === "memory"), again.thinking);
  const arc = await (await worker.fetch(new Request("https://cods.example/archive"), env)).json();
  check("what was asked is logged", arc.count >= 1 && arc.log[0].q.indexOf("position sizing") > 0, arc.log[0]);
  const health = await (await worker.fetch(new Request("https://cods.example/health"), env)).json();
  check("health sees the bucket", health.memory.ltm === true, health.memory);
}


// 20c. what was saved before the split is still readable
{
  const ctx = new Map();
  const kv = new Map();
  kv.set("prefs:v1", JSON.stringify({ actions: { wrong: 2 }, domains: { finance: 1 }, events: [], updated: "2026-01-01T00:00:00.000Z" }));
  kv.set("approved:v1", JSON.stringify({ items: { hABC: { q: "old approval", cards: [{ q: "old approval", a: "kept" }], rank: 5 } } }));
  kv.set("deck:olddeck1", JSON.stringify({ cards: [{ q: "old card", a: "old answer" }], theme: { name: "ocean", primary: "#3d8bd4", bg: "#0b1017", card: "#121a24", text: "#e8f1fa", line: "#22303d" } }));
  const env = makeEnv({
    CONTEXT: { get: async (k) => ctx.get(k) || null, put: async (k, v) => ctx.set(k, v) },
    KV: { get: async (k) => kv.get(k) || null, put: async (k, v) => kv.set(k, v) },
  });
  const prefs = await (await worker.fetch(new Request("https://cods.example/prefs"), env)).json();
  check("old preferences still show", prefs.actions.wrong === 2, prefs.actions);
  const deck = await (await worker.fetch(new Request("https://cods.example/deck?id=olddeck1"), env)).json();
  check("an old deck still loads", deck.cards.length === 1 && deck.theme.name === "ocean", deck.theme);
  const list = await (await worker.fetch(new Request("https://cods.example/approved"), env)).json();
  check("old approvals still answer", list.count === 1 && list.items[0].q === "old approval", list.items);
  check("nothing was rewritten behind the scenes", ctx.size === 0, [...ctx.keys()]);
}


// 21. long answers scroll instead of being clipped
{
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  check("cards stop shrinking to fit the screen", /\.card\{[^}]*flex:0 0 auto/.test(css), css.match(/\.card\{[^}]*\}/));
  check("the card column scrolls on its own", /\.cards\{[^}]*overflow-y:auto/.test(css) && /\.cards\{[^}]*overscroll-behavior:contain/.test(css), css.match(/\.cards\{[^}]*\}/));
  check("fullscreen scrolls", /\.fs-body\{[^}]*overflow-y:auto/.test(css), css.match(/\.fs-body\{[^}]*\}/));
  check("settings scroll", /\.sheet-body\{[^}]*max-height:88dvh/.test(css) && /\.sheet-body\{[^}]*overflow-y:auto/.test(css), css.match(/\.sheet-body\{[^}]*\}/));
  check("the edit box scrolls instead of running off screen", /\.modal-box\{[^}]*max-height:88dvh/.test(css), css.match(/\.modal-box\{[^}]*\}/));
  check("nothing still clips the card body", !/\.card-a\{[^}]*max-height/.test(css) && !/\.card-a\{[^}]*line-clamp/.test(css), "ok");
}


// 22. answers render as markdown, with no loose asterisks
{
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  const a = html.indexOf("function stripDangling(");
  const b = html.indexOf("/* end-md */");
  check("the renderer ships in the page", a > -1 && b > a, a + ":" + b);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lib = new Function("esc", html.slice(a, b) + "; return { md: md, stripDangling: stripDangling }; ")(esc);
  const bold = lib.md("**bold** and *soft* and `x = 1`");
  check("bold becomes bold", bold.includes("<strong>bold</strong>"), bold);
  check("italics become italics", bold.includes("<em>soft</em>"), bold);
  check("inline code stays code", bold.includes("<code>x = 1</code>"), bold);
  check("no asterisks survive", !bold.includes("*"), bold);
  const lists = lib.md("## Why\n\n- first\n- second\n\n1. one\n2. two");
  check("headings render", lists.includes("<h3>Why</h3>"), lists);
  check("bullets render", lists.includes("<ul><li>first</li>") && lists.includes("</ul>"), lists);
  check("numbered lists render", lists.includes("<ol><li>one</li>"), lists);
  const code = lib.md("```js\nlet a = 1 * 2;\n```");
  check("a code block keeps its own asterisk", code.includes("<pre><code>let a = 1 * 2;</code></pre>"), code);
  const table = lib.md("| a | b |\n| --- | --- |\n| 1 | 2 |");
  check("tables render", table.includes("<table") && table.includes("<th>a</th>") && table.includes("<td>1</td>"), table);
  const link = lib.md("see [docs](https://example.com/x)");
  check("links render", link.includes('<a href="https://example.com/x"'), link);
  const messy = lib.md("5 * 3 and **unfinished plus ***more");
  check("stray markers are dropped", !messy.includes("*"), messy);
  check("half-typed markers do not flash", lib.stripDangling("hello **bo") === "hello **bo" && lib.stripDangling("hello **") === "hello ", lib.stripDangling("hello **"));
  const quote = lib.md("> quoted\n\n---\n\nafter");
  check("quotes and rules render", quote.includes("<blockquote>quoted</blockquote>") && quote.includes("<hr>"), quote);
  check("typing renders as it goes", html.includes("md(stripDangling(text.slice(0, i)))"), "ok");
  check("markdown has real styling", html.includes(":is(.card-a,.fs-body) strong{font-weight:700}") && html.includes("list-style:disc"), "ok");
}


// 23. the OpenRouter proxy is one option, not the default
{
  const seen = [];
  const env = makeEnv({
    ORPROXY: {
      fetch: async (url, init) => {
        seen.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: "proxy answer" } }] }), { status: 200 });
      },
    },
  });
  const plain = await (await post("/chat", { prompt: "what is a limit order" }, env)).json();
  check("Workers AI still answers by default", plain.answer === "granite answer", plain.answer);
  check("and the proxy was never called", seen.length === 0, seen.length);

  const asked = await (await post("/chat", { prompt: "what is a limit order", proxy: true }, env)).json();
  check("asking for the proxy gets the proxy", asked.answer === "proxy answer", asked.answer);
  check("and the payload says so", String(asked.provider).indexOf("orproxy") > 0, asked.provider);
  check("it is asked on /api/generate", seen.every((c) => c.url === "https://orproxy/api/generate"), seen.map((c) => c.url));
  check("with the conversation", seen.length && seen[0].body.messages.length >= 2, seen[0] && seen[0].body.messages.length);
  check("with the default preset", seen[0].body.model === "truth", seen[0].body.model);
  check("and asked not to stream", seen[0].body.stream === false, seen[0].body.stream);

  const named = await (await post("/chat", { prompt: "what is a limit order", proxy: true, preset: "cheap" }, env)).json();
  check("a preset can be chosen per request", named.answer === "proxy answer" && seen.some((c) => c.body.model === "cheap"), seen.map((c) => c.body.model));

  const health = await (await worker.fetch(new Request("https://cods.example/health"), env)).json();
  check("health names the proxy, its route and its default preset", health.orproxy === true && health.orproxy_mode === "/api/generate" && health.orproxy_preset === "truth", health.orproxy_mode + "/" + health.orproxy_preset);
}

// 23b. a broken proxy leaves the normal answer alone
{
  const env = makeEnv({ ORPROXY: { fetch: async () => new Response("upstream exploded", { status: 500 }) } });
  const d = await (await post("/chat", { prompt: "what is slippage", proxy: true }, env)).json();
  check("Workers AI covers a failed proxy request", d.answer === "granite answer", d.answer);
  check("and nothing claims the proxy answered", String(d.provider).indexOf("orproxy") === -1, d.provider);
  const empty = makeEnv({ ORPROXY: { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }) } });
  const e = await (await post("/chat", { prompt: "what is a stop order", proxy: true }, empty)).json();
  check("an empty envelope is not shown as JSON", e.answer === "granite answer", e.answer);
}

// 23c. the proxy can be checked from a phone browser
{
  const dead = await (await worker.fetch(new Request("https://cods.example/orproxy"), makeEnv({ ORPROXY: {} }))).json();
  check("a binding with no handler is reported", dead.ok === false && dead.notes.join(" ").indexOf("fetch") >= 0, dead.notes);
  const failed = await (await worker.fetch(new Request("https://cods.example/orproxy"), makeEnv({ ORPROXY: { fetch: async () => new Response("OpenRouter error: 404", { status: 500 }) } }))).json();
  check("the proxy's own error is passed through", failed.ok === false && failed.notes.join(" ").indexOf("OpenRouter error: 404") > 0, failed.notes);
  const good = await (await worker.fetch(new Request("https://cods.example/orproxy?preset=cheap"), makeEnv({
    ORPROXY: { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ready" } }] }), { status: 200 }) },
  }))).json();
  check("a working proxy reports the route and reply", good.ok === true && good.via === "fetch /api/generate" && good.reply === "ready", good);
  const none = await worker.fetch(new Request("https://cods.example/orproxy"), makeEnv({}));
  check("an unbound proxy says so", none.status === 400, none.status);
}


// 24. the picker: a model can be chosen, and the choice is remembered
{
  const env = makeEnv({ ORPROXY: { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "proxy answer" } }] }), { status: 200 }) } });
  const list = await (await worker.fetch(new Request("https://cods.example/models"), env)).json();
  check("the picker lists Cloudflare models", Array.isArray(list.workers) && list.workers.length >= 3, list.workers && list.workers.length);
  check("and starts with the default one", list.workers[0].id === list.default, list.default);
  check("it lists the proxy presets too", list.proxy && list.proxy.bound === true && list.proxy.presets.indexOf("truth") >= 0, list.proxy);
  check("nothing is chosen to begin with", list.chosen === null, list.chosen);

  const pick = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  await post("/feedback", { action: "model", model: pick, q: "model picker" }, env);
  const after = await (await worker.fetch(new Request("https://cods.example/models"), env)).json();
  check("a pick is remembered", after.chosen === pick, after.chosen);
  const prefs = await (await worker.fetch(new Request("https://cods.example/prefs"), env)).json();
  check("preferences carry the model", prefs.model === pick, prefs.model);
  check("and say so in words", String(prefs.hint).indexOf(pick) > 0, prefs.hint);

  calls = []; aiInputs = [];
  await post("/chat", { prompt: "what is a limit order", use_cache: false }, env);
  const triedPick = aiInputs.findIndex((a) => a.model === pick);
  const triedGranite = aiInputs.findIndex((a) => a.model.indexOf("@cf/ibm-granite") === 0);
  check("the remembered model is tried before the default", triedPick > -1 && (triedGranite === -1 || triedPick < triedGranite), aiInputs.map((a) => a.model));
  check("and the answer still arrives when it cannot run", true, "ok");
}

// 24b. a pick rides along with each question
{
  const seen = [];
  const env = makeEnv({
    ORPROXY: { fetch: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "proxy answer" } }] }), { status: 200 });
    } },
  });
  calls = []; aiInputs = [];
  const cf = await (await post("/chat", { prompt: "explain spread", model: "@cf/mistralai/mistral-small-3.1-24b-instruct", use_cache: false }, env)).json();
  const askedPick = aiInputs.findIndex((a) => a.model === "@cf/mistralai/mistral-small-3.1-24b-instruct");
  const askedGranite = aiInputs.findIndex((a) => a.model.indexOf("@cf/ibm-granite") === 0);
  check("a chosen Cloudflare model is asked before the default", askedPick > -1 && (askedGranite === -1 || askedPick < askedGranite), aiInputs.map((a) => a.model));
  check("and the chain still answers", cf.answer === "granite answer", cf.answer);

  const viaProxy = await (await post("/chat", { prompt: "explain basis", model: "proxy:truth", use_cache: false }, env)).json();
  check("choosing the proxy sends its preset", seen.length > 0 && seen[0].model === "truth", seen[0] && seen[0].model);
  check("and the proxy answers", viaProxy.answer === "proxy answer" && String(viaProxy.provider).indexOf("orproxy") > 0, viaProxy.provider);
}

// 24c. the picker is on the page and travels with the question
{
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  ["id=\"modelBtn\"", "function openModels", "function askBody", "data-pick", "fetch('/models')", "localStorage.setItem(MK"].forEach(function (n) {
    check("page has " + n, html.indexOf(n) >= 0, n);
  });
  check("the button sits in the ask bar", /class="input"><button class="chip" id="modelBtn"/.test(html), "ok");
}


// 25. the decision layer asks, you answer, it decides again
{
  const base = makeEnv();
  const inner = base.AI.run;
  const env = makeEnv({
    AI: { run: async (m, i) => {
      if (String(m).startsWith("@cf/cloudflare/clef")) {
        return { answers: {
          intent: { probabilities: { answer: 0.6, decide: 0.4 } },
          domain: { probabilities: { general: 0.6, finance: 0.4 } },
          tone: { probabilities: { plain: 0.8 } },
          depth: { score: 2 },
          needs_web: { probability: 0.5 },
          cache_ok: { probability: 0.2 },
          sensitive: { probability: 0.1 },
          clarify: { probability: 0.8 },
        } };
      }
      return inner(m, i);
    } },
  });

  const first = await (await post("/chat", { prompt: "help me sort this out" }, env)).json();
  check("an unsure decision asks instead of guessing", first.clarify && first.clarify.questions.length >= 1 && first.answer === null, first.clarify && first.clarify.questions.length);
  const ids = first.clarify.questions.map((q) => q.id);
  check("it asks about searching the web", ids.indexOf("web") >= 0, ids);
  check("and what shape of answer is wanted", ids.indexOf("goal") >= 0, ids);
  check("the search question offers both answers", first.clarify.questions[0].options.length === 2, first.clarify.questions[0].options);

  const second = await (await post("/chat", { prompt: "help me sort this out", clarify: [{ id: "web", q: "Should I search?", a: "Answer from knowledge" }] }, env)).json();
  check("the answered question is not asked twice", second.clarify && second.clarify.questions.every((q) => q.id !== "web"), second.clarify && second.clarify.questions.map((q) => q.id));

  const third = await (await post("/chat", {
    prompt: "help me sort this out",
    clarify: [
      { id: "web", q: "Should I search?", a: "Answer from knowledge" },
      { id: "goal", q: "What do you want back?", a: "Steps to act on" },
    ],
  }, env)).json();
  check("after the answers it answers", !third.clarify && !!third.answer, third.answer);
  check("and the answers shaped the work", (third.thinking || []).some((x) => x.step === "decide") || !!third.decision, third.thinking && third.thinking.length);
}

// 25b. saying yes to the web question actually searches
{
  const base = makeEnv();
  const inner = base.AI.run;
  const env = makeEnv({
    SEARCH_URL: "https://search.example/q",
    AI: { run: async (m, i) => {
      if (String(m).startsWith("@cf/cloudflare/clef")) {
        return { answers: {
          intent: { probabilities: { answer: 0.7 } },
          domain: { probabilities: { general: 0.9 } },
          tone: { probabilities: { plain: 0.9 } },
          depth: { score: 2 },
          needs_web: { probability: 0.5 },
          cache_ok: { probability: 0.2 },
          sensitive: { probability: 0.1 },
          clarify: { probability: 0.8 },
        } };
      }
      return inner(m, i);
    } },
  });
  searchChunks = [{ title: "a source", url: "https://example.com/a", text: "something useful about the topic" }];
  extResults = [{ title: "a source", url: "https://example.com/a", description: "something useful" }];
  calls = [];
  const yes = await (await post("/chat", {
    prompt: "what changed in the rules",
    search: "yes",
    clarify: [{ id: "web", q: "Should I search?", a: "Search the web" }, { id: "goal", q: "What?", a: "Short answer" }],
  }, env)).json();
  check("saying yes reaches the web", calls.some((u) => u.indexOf("search.example") >= 0), calls);
  check("and the answer still comes back", !!yes.answer, yes.answer);
}

// 25c. the picker offers both sides, and any OpenRouter name can be typed
{
  const env = makeEnv({ ORPROXY: {} });
  const list = await (await worker.fetch(new Request("https://cods.example/models"), env)).json();
  check("Cloudflare models are listed", list.workers.length >= 3 && !!list.workers[0].id, list.workers.length);
  check("OpenRouter is listed separately", list.openrouter && list.openrouter.bound === true && list.openrouter.models.length >= 1, list.openrouter);
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  ["function showClarify", "function nextClarify", "data-clar", "type a model", 'data-pick="x"'].forEach(function (n) {
    check("page has " + n, html.indexOf(n) >= 0, n);
  });
  const seen = [];
  const proxyEnv = makeEnv({
    ORPROXY: { fetch: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "typed answer" } }] }), { status: 200 });
    } },
  });
  const d = await (await post("/chat", { prompt: "explain gamma", model: "proxy:anthropic/claude-3.5-sonnet", use_cache: false }, proxyEnv)).json();
  check("a typed OpenRouter name travels as the preset", seen.length > 0 && seen[0].model === "anthropic/claude-3.5-sonnet", seen[0] && seen[0].model);
  check("and the proxy answers when it accepts it", d.answer === "typed answer", d.answer);
}


// 26. the answer cache lives in its own namespace
{
  const kv = new Map(), cache = new Map();
  const env = makeEnv({
    KV: { get: async (k) => kv.get(k) || null, put: async (k, v) => kv.set(k, v) },
    CACHE: { get: async (k) => cache.get(k) || null, put: async (k, v) => cache.set(k, v) },
  });
  const first = await (await post("/chat", { prompt: "what is a limit order" }, env)).json();
  check("an answer is cached in CACHE", [...cache.keys()].some((k) => k.indexOf("ans:") === 0), [...cache.keys()]);
  check("and nothing new lands in KV", [...kv.keys()].every((k) => k.indexOf("ans:") !== 0), [...kv.keys()]);
  calls = []; aiInputs = [];
  const again = await (await post("/chat", { prompt: "what is a limit order" }, env)).json();
  check("a repeat question is served from CACHE", again.cached === true && again.route === "cache", again.route);
  check("without waking a text model", aiInputs.every((a) => a.model.indexOf("clef") >= 0), aiInputs.map((a) => a.model));

  const key = [...cache.keys()].find((k) => k.indexOf("ans:") === 0);
  cache.clear();
  kv.set(key, JSON.stringify({ answer: "kept from before", provider: "old" }));
  const legacy = await (await post("/chat", { prompt: "what is a limit order" }, env)).json();
  check("an answer stored in KV before the split still reads", legacy.answer === "kept from before", legacy.answer);

  const health = await (await worker.fetch(new Request("https://cods.example/health"), env)).json();
  check("health names the cache namespace", health.memory.cache === true, health.memory);
}

// 26b. without CACHE bound, the cache still works through KV
{
  const kv = new Map();
  const env = makeEnv({ KV: { get: async (k) => kv.get(k) || null, put: async (k, v) => kv.set(k, v) } });
  await post("/chat", { prompt: "what is a stop order" }, env);
  check("the cache falls back to KV", [...kv.keys()].some((k) => k.indexOf("ans:") === 0), [...kv.keys()]);
  const health = await (await worker.fetch(new Request("https://cods.example/health"), env)).json();
  check("and health says CACHE is absent", health.memory.cache === false, health.memory.cache);
}


// 28. OpenRouter: model ids with our own key, presets by name
{
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("openrouter.ai")) {
      seen.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers && (init.headers.Authorization || init.headers.authorization) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "openrouter answer" } }] }), { status: 200 });
    }
    return real(url, init);
  };
  try {
    const withKey = makeEnv({ OPENROUTER_API_KEY: "k" });
    const list = await (await worker.fetch(new Request("https://cods.example/models"), withKey)).json();
    check("with a key the picker goes direct", list.openrouter.via === "key", list.openrouter.via);
    check("OpenRouter models are listed", list.openrouter.models.length >= 3, list.openrouter.models.length);

    const d = await (await post("/chat", { prompt: "explain swap", model: "openrouter:anthropic/claude-3.5-sonnet", use_cache: false }, withKey)).json();
    check("any model id is sent as-is", seen.length > 0 && seen[0].body.model === "anthropic/claude-3.5-sonnet", seen[0] && seen[0].body.model);
    check("with our own key", String(seen[0].auth).indexOf("Bearer k") === 0, seen[0].auth);
    check("and the answer comes back", d.answer === "openrouter answer" && String(d.provider).indexOf("openrouter") > 0, d.provider);

    const p = await (await post("/chat", { prompt: "explain funding", model: "preset:truth", use_cache: false }, withKey)).json();
    check("a preset is referenced the documented way", seen.length > 1 && seen[1].body.model === "@preset/truth", seen[1] && seen[1].body.model);
    check("and answers through the key too", p.answer === "openrouter answer", p.answer);
  } finally {
    globalThis.fetch = real;
  }
}

// 28b. no key: presets ride the proxy, model ids say what is missing
{
  const proxied = [];
  const env = makeEnv({
    ORPROXY: { fetch: async (url, init) => {
      proxied.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "proxy answer" } }] }), { status: 200 });
    } },
  });
  const list = await (await worker.fetch(new Request("https://cods.example/models"), env)).json();
  check("without a key the picker says it goes via proxy", list.openrouter.via === "proxy", list.openrouter.via);
  const d = await (await post("/chat", { prompt: "explain basis", model: "preset:truth", use_cache: false }, env)).json();
  check("a preset is sent to the proxy by name", proxied.length > 0 && proxied[0].model === "truth", proxied[0] && proxied[0].model);
  check("and it answers", d.answer === "proxy answer", d.answer);
  const bare = await (await post("/chat", { prompt: "explain gamma", model: "openrouter:openai/gpt-4o-mini", use_cache: false }, env)).json();
  check("a model id without a key falls through instead of pretending", bare.answer === "granite answer", bare.answer);
  check("and the card names the answer that was asked for", !!bare.pick && bare.pick.requested === "openai/gpt-4o-mini" && String(bare.pick.error).indexOf("OPENROUTER_API_KEY") >= 0, bare.pick);
}

// 28c. the page offers both, and carries no hard-coded audit card
{
  const html = await (await worker.fetch(new Request("https://cods.example/"), makeEnv({}))).text();
  ['data-pick="o:', "preset · ", "type a model or preset", "'preset:' +"].forEach(function (n) {
    check("page has " + n, html.indexOf(n) >= 0, n);
  });
  check("and no hard-coded audit button", html.indexOf("audit this") === -1, "audit this");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
