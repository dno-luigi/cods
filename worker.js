// cards — single entrypoint, inline frontend
// Provider chain: ARA (optional) → Cloudflare Workers AI (optional) → OpenRouter
const cH = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
let cards = [];
const el = {
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
function render() {
  el.count.textContent = cards.length;
  if (!cards.length) {
    el.cards.innerHTML = '<div class="empty"><h3>No cards yet</h3><p>Type below to start</p></div>';
    return;
  }
  el.cards.innerHTML = cards.map(function (c) {
    return '<div class="card"><div class="card-q">' + esc(c.q) + '</div>' +
      '<div class="card-a">' + esc(c.a) + '</div>' +
      '<div class="provider">via ' + esc(c.provider) + '</div></div>';
  }).join('');
}
async function send() {
  const p = el.prompt.value.trim();
  if (!p) return;
  el.prompt.value = '';
  el.send.disabled = true;
  el.send.textContent = '...';

  const card = { q: p, a: 'Thinking...', provider: 'pending' };
  cards.push(card);
  render();

  try {
    const r = await fetch('https://cods.ai-n.workers.dev/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: p,
        cards: cards.slice(0, -1).map(function (c) { return { q: c.q, r: c.a }; })
      })
    });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch (e) { d = null; }

    if (!d) {
      card.a = 'Server returned ' + r.status + ': ' + text.slice(0, 300);
      card.provider = 'error';
    } else if (d.error) {
      card.a = d.error;
      card.provider = 'error ' + r.status;
    } else {
      card.a = d.answer || d.response || '(no response)';
      card.provider = d.provider || 'openrouter';
    }
  } catch (e) {
    card.a = 'Network error: ' + (e && e.message ? e.message : e);
    card.provider = 'error';
  } finally {
    el.send.disabled = false;
    el.send.textContent = 'Send';
    render();
  }
}
el.send.onclick = send;
el.prompt.onkeydown = function (e) { if (e.key === 'Enter') send(); };
el.cards.onclick = function (e) {
  const c = e.target.closest ? e.target.closest('.card') : null;
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
        ai: !!env.AI,
        ara: !!env.ARA,
        openrouter: !!env.OPENROUTER_API_KEY,
        kv: !!env.KV,
      });
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

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json({ error: "No prompt" }, 400);

  const model = body.model || env.OPENROUTER_MODEL || "inclusionai/ling-2.6-flash";
  const temperature = body.temperature ?? 0.7;
  const maxTokens = body.max_tokens || 2000;
  const system = body.system || "";
  const contextCards = Array.isArray(body.cards) ? body.cards.filter((c) => c && c.q) : [];

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  if (contextCards.length) {
    messages.push({
      role: "system",
      content:
        "Existing cards in this session:\n" +
        contextCards.map((c) => "Request: " + c.q + "\nResponse: " + (c.r || "")).join("\n---\n"),
    });
  }
  messages.push({ role: "user", content: prompt });

  const cacheKey = await hashKey(prompt + JSON.stringify(contextCards) + model);

  if (env.KV) {
    try {
      const cached = await env.KV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.cached = true;
        return json(parsed);
      }
    } catch (err) {}
  }

  const failures = [];

  // 1. ARA (analytical engine, if a service binding exists)
  if (env.ARA) {
    try {
      const araRes = await env.ARA.fetch("https://ara/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, system, model, max_tokens: maxTokens }),
      });
      if (araRes.ok) {
        const araData = await araRes.json();
        const answer = araData.response || araData.answer;
        if (answer) {
          return finish(env, cacheKey, answer, "ara", araData.trail || []);
        }
      }
      failures.push("ara: HTTP " + araRes.status);
    } catch (err) {
      failures.push("ara: " + err.message);
    }
  }

  // 2. Cloudflare Workers AI (free, fast — needs the AI binding)
  if (env.AI) {
    const cfModel = body.cf_model || "@cf/meta/llama-3.1-8b-instruct";
    try {
      const aiResponse = await env.AI.run(cfModel, {
        messages,
        max_tokens: maxTokens,
        temperature,
      });
      const raw = aiResponse && (aiResponse.response ?? aiResponse);
      const answer = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (answer && answer !== "null") {
        return finish(env, cacheKey, answer, "cloudflare-ai", [
          { domain: "llm", confidence: 0.75, source: "cloudflare-ai", model: cfModel },
        ]);
      }
      failures.push("workers-ai: empty response");
    } catch (err) {
      failures.push("workers-ai: " + err.message);
    }
  }

  // 3. OpenRouter (needs OPENROUTER_API_KEY as a Worker secret)
  if (!env.OPENROUTER_API_KEY) {
    failures.push("openrouter: OPENROUTER_API_KEY is not set on this Worker");
  } else {
    let usedModel = model;
    try {
      let answer;
      try {
        answer = await callOpenRouter(env, model, messages, maxTokens, temperature);
      } catch (err) {
        // unknown / unavailable model → retry once on a widely available one
        if (err.status === 400 || err.status === 404) {
          usedModel = "openai/gpt-4o-mini";
          answer = await callOpenRouter(env, usedModel, messages, maxTokens, temperature);
        } else {
          throw err;
        }
      }
      return finish(env, cacheKey, answer, "openrouter", [
        { domain: "llm", confidence: 0.75, source: "openrouter", model: usedModel },
      ]);
    } catch (err) {
      failures.push("openrouter: " + err.message);
    }
  }

  return json(
    {
      error:
        "No provider returned an answer. " +
        failures.join(" | ") +
        " — set the key with: wrangler secret put OPENROUTER_API_KEY",
      failures,
    },
    502
  );
}

async function finish(env, cacheKey, answer, provider, trace) {
  const payload = {
    answer,
    response: answer,
    accumulated: answer,
    cards: [{ q: "", r: answer }],
    trace,
    confidence: 0.75,
    cached: false,
    provider,
  };
  if (env.KV && answer) {
    try {
      await env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 });
    } catch (err) {}
  }
  return json(payload);
}

async function callOpenRouter(env, model, messages, maxTokens, temperature) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "X-Title": "cards",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
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
