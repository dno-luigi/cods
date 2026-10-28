import worker from "./worker.js";

let calls = [];
let aiInputs = [];
let searchChunks = [];
let failSearch = null;
let uploaded = [];

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
  for (const path of ["/search", "/cards", "/notes", "/chat"]) {
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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
