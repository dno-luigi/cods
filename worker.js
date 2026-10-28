/**
 * cards — Cloudflare Worker
 *
 * Routes
 *   POST /chat           → the card endpoint used by public/script.js (single model call, KV cached)
 *   POST /api/ara/query  → recursive 5-domain confidence pipeline
 *   GET  /api/ara/status → health probe
 *   everything else      → static assets (public/)
 *
 * Universal -> Ethical -> Macro -> Micro -> Domain-Specific
 * Loops up to 5 times; any domain >= 60% stops.
 **/

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'inclusionai/ling-2.6-flash';
const CACHE_TTL = 60 * 60; // 1h (KV expirationTtl is in seconds)
const MAX_LOOPS = 5;
const CONF_THRESH = 60;
const LLM_FALLBACK_START = 75;

const SYSTEM_PROMPT =
  'You are ai-ncards, a card-based document builder. Keep responses concise and immediately useful. ' +
  'Support actions: !action:merge! !action:clear! !action:view:grid! and theme: !theme:Name,Primary,Bg,CardBg,Text,Border!';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

function sse(payload) {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

function wantsStream(request) {
  return (request.headers.get('Accept') || '').includes('text/event-stream');
}

// ─── KV cache helpers (env.KV is the binding declared in wrangler.jsonc) ───
async function cacheGet(env, key) {
  if (!env.KV) return null;
  try {
    const raw = await env.KV.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
      await env.KV.delete(key);
      return null;
    }
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

async function cacheSet(env, key, data, ttlSeconds = CACHE_TTL) {
  if (!env.KV) return;
  try {
    await env.KV.put(key, JSON.stringify({ data, expiresAt: Date.now() + ttlSeconds * 1000 }), {
      expirationTtl: ttlSeconds,
    });
  } catch {
    /* caching is best-effort */
  }
}

async function hashKey(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Model call (no proxy, no self-fetch) ───
async function openRouter(env, { model, messages, tools, stream = false }) {
  const payload = { model, messages, max_tokens: 2000 };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  if (stream) payload.stream = true;

  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://ai.nspired.cc',
      'X-Title': 'cards',
    },
    body: JSON.stringify(payload),
  };
  // Only bound non-streaming calls; a stream may legitimately run long.
  if (!stream) init.signal = AbortSignal.timeout(45000);

  return fetch(OPENROUTER_URL, init);
}

async function llm(env, prompt, system = SYSTEM_PROMPT) {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set on this Worker (add it as a secret: wrangler secret put OPENROUTER_API_KEY)');
  }

  let res;
  try {
    res = await openRouter(env, {
      model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });
  } catch (e) {
    throw new Error(`Model request failed: ${e.message}`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Model error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error('Model returned an empty response');
  return text.trim();
}

// ─── /chat — produces the cards the UI renders ───
async function handleChat(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: 'Missing "prompt"' }, 400);

  const contextCards = Array.isArray(body.cards) ? body.cards : [];
  const contextMsg = contextCards.length
    ? '\n\nExisting cards:\n' + contextCards.map((c) => `Request: ${c.q}\nResponse: ${c.r}`).join('\n---\n')
    : '';
  const fullPrompt = prompt + contextMsg;

  const cacheKey = await hashKey(fullPrompt);
  const cached = await cacheGet(env, cacheKey);

  let text;
  let isCached = false;
  if (cached) {
    text = cached;
    isCached = true;
  } else {
    try {
      text = await llm(env, fullPrompt);
    } catch (e) {
      // `answer` is what the UI renders, so surface the failure as a card instead of silence.
      const message = e.message || 'Unknown model error';
      return json(
        { error: message, answer: `⚠️ ${message}`, cards: [{ q: prompt, r: `⚠️ ${message}` }], cached: false },
        502
      );
    }
    await cacheSet(env, cacheKey, text);
  }

  const payload = {
    response: text,
    answer: text,
    cards: [{ q: prompt, r: text }],
    cached: isCached,
    timestamp: new Date().toISOString(),
  };

  return wantsStream(request) ? sse(payload) : json(payload);
}

// ─── Hermetic Universal (always applied as a lens) ───
const HERMETIC = [
  { id: 'correspondence', name: 'Law of Correspondence', regex: /as above so below|correspondence|mirror|reflect/i },
  { id: 'vibration',     name: 'Law of Vibration',     regex: /vibration|frequency|energy|oscillat/i },
  { id: 'polarity',      name: 'Law of Polarity',      regex: /opposite|balance|dual|pendulum|yin yang|balance/i },
  { id: 'rhythm',        name: 'Law of Rhythm',       regex: /cycle|rhythm|season|ebb flow|wax wane/i },
  { id: 'cause_effect',  name: 'Law of Cause & Effect',regex: /cause effect|karma|as you sow so shall you reap|action consequence/i },
  { id: 'gender',        name: 'Law of Gender',       regex: /masculine feminine|principle of gender/i },
  { id: 'perpetual',     name: 'Law of Perpetual Change',regex: /perpetual|constant change|nothing stays|motion/i },
  { id: 'mentalism',     name: 'Principle of Mentalism',regex: /all is mind|mental universe|thought creates|imagination/i },
];

function universalLens(text, prior) {
  let matched = 0;
  const found = [];
  for (const p of HERMETIC) { if (p.regex.test(text)) { matched++; found.push(p.id); } }
  const baseScore = 10 + (matched / HERMETIC.length) * 40;
  const priorBoost = ((prior.universal || []).filter((u) => found.includes(u)).length) * 3;
  return { score: Math.min(100, baseScore + priorBoost), matchedPrinciples: found };
}

// ─── Ethical hard stop ───
const HARM_PATTERNS = [
  /kill|murder|harm|hurt|violent|bomb|shoot|attack|self[-\s]?harm|suicide|harm myself|end my life|self-harm/i,
  /kill.*animal|hurt.*animal|shoot.*animal|harm.*animal/i,
  /bomb building|make a bomb|build a weapon|create a bomb|make a gun|shooting|pipe bomb|chemical weapon|bioweapon/i,
  /racist|sexist|misogyny|homophob|transphob|xenophob|bigot|hate speech|ethnic slurs/gi,
  /self[-\s]?destruct|destroy myself|hurt myself|abuse|trafficking|exploitation|suffering|pain|overdose|self[-\s]?injury/gi,
  /make a weapon|craft a weapon|build a firearm|3d printed gun|ghost gun|cnc milling weapon/i,
  /deport|genocide|ethnic cleansing|wipe out|eradicate|annihilate|exterminate|massacre/gi,
  /how (?:to |)kill|how (?:to )?murder|how (?:to )?poison|how (?:to )?shoot|how (?:to )?attack|how (?:to )?harm/i,
];
function ethicalScore(text) {
  for (const pat of HARM_PATTERNS) if (pat.test(text)) return 100;
  return 0;
}

// ─── Macro = broad view ───
async function macroView(env, text, prior, step) {
  const prompt = `You are providing a broad, high-level view of the issue in the user's question. Focus on context, scope, and big-picture framing.\n\nUser: ${text}\nPrior (step ${step}): ${JSON.stringify(prior.macro || [])}`;
  const output = await llm(env, prompt);
  return { output, confidence: 30 + Math.floor(Math.random() * 20) };
}

// ─── Micro = close-up view ───
async function microView(env, text, prior, step) {
  const prompt = `You are examining the issue in close detail: specifics, edge cases, constraints, and exact requirements.\n\nUser: ${text}\nPrior (step ${step}): ${JSON.stringify(prior.micro || [])}`;
  const output = await llm(env, prompt);
  return { output, confidence: 30 + Math.floor(Math.random() * 20) };
}

// ─── Domain-specific = deep into the actual field ───
async function domainSpecific(env, text, prior, step, domain) {
  const priorBlock = JSON.stringify({
    universal: prior.universal || [],
    macro: prior.macro || [],
    micro: prior.micro || [],
    domain: prior.domain || [],
  });
  const prompt = `Domain-specific deep-dive (${domain}). Read macro view and micro specifics, then go deeper into this field.\n\nUser: ${text}\nPrior all steps: ${priorBlock}`;
  const output = await llm(env, prompt);
  return { output, confidence: 40 + Math.floor(Math.random() * 30) };
}

async function routeDomain(env, text, prior, step) {
  return domainSpecific(env, text, prior, step, 'general');
}

// ─── Optional: browser scraping, best-effort per iteration ───
async function scrapeWithContext(origin, promptFragment) {
  const readyRes = await fetch(new URL('/api/browser/ready', origin));
  if (!readyRes.ok) throw new Error(`browser not ready (${readyRes.status})`);
  const res = await fetch(new URL('/api/browser/render', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: '', prompt: promptFragment, timeout: 15000 }),
  });
  const data = await res.json();
  return data.text || '';
}

// ─── Main recursive orchestration ───
async function process(env, userPrompt, prevTurn = null, scrapeUrl = null, origin = 'https://ai.nspired.cc') {
  const trace = [];
  const accumulated = {
    loop: [],
    universal: [],
    ethical: [],
    macro: [],
    micro: [],
    domain: [],
    context: [],
  };

  const loopUrl = scrapeUrl;

  for (let i = 0; i < MAX_LOOPS; i++) {
    let loopContext = '';
    if (loopUrl) {
      try {
        loopContext = await scrapeWithContext(origin, loopUrl);
        accumulated.context.push({ iteration: i, context: loopContext });
      } catch (e) {
        console.warn('Browser scrape failed for iteration', i, e.message);
      }
    }

    const prior = {
      universal: accumulated.universal,
      macro: accumulated.macro,
      micro: accumulated.micro,
      domain: accumulated.domain,
    };

    // --- Universal (always applied as lens) ---
    const u = universalLens(userPrompt, prior);
    accumulated.universal.push(...u.matchedPrinciples);
    trace.push({ iteration: i, stage: 'universal', score: u.score, principles: u.matchedPrinciples });

    // --- Ethical hard stop ---
    const e = ethicalScore(userPrompt);
    accumulated.ethical.push(e);
    trace.push({ iteration: i, stage: 'ethical', score: e });
    if (e >= CONF_THRESH) {
      return finalize('rejected', `Ethical guardrail triggered at iteration ${i}.`, trace, accumulated, e);
    }

    // --- Macro / Micro / Domain ---
    const m = await macroView(env, userPrompt, prior, i);
    accumulated.macro.push(m.output);
    trace.push({ iteration: i, stage: 'macro', score: m.confidence });

    const mi = await microView(env, userPrompt, prior, i);
    accumulated.micro.push(mi.output);
    trace.push({ iteration: i, stage: 'micro', score: mi.confidence });

    const d = await routeDomain(env, userPrompt, prior, i);
    accumulated.domain.push(d.output);
    trace.push({ iteration: i, stage: 'domain', route: 'general', score: d.confidence });

    const runningConfidence = Math.round(
      (Number(u.score) + Number(m.confidence) + Number(mi.confidence) + Number(d.confidence)) / 4
    );

    if (d.confidence >= CONF_THRESH || runningConfidence >= CONF_THRESH) {
      return finalize(
        'resolved',
        `Converged at iteration ${i + 1} with ${runningConfidence}% confidence.`,
        trace,
        accumulated,
        runningConfidence,
        d.output
      );
    }
  }

  const fallbackPrompt = `Synthesize a thorough answer from: Universal=${JSON.stringify(accumulated.universal)}, Macro=${JSON.stringify(accumulated.macro)}, Micro=${JSON.stringify(accumulated.micro)}, Domain=${JSON.stringify(accumulated.domain)}, Original="${userPrompt}". Provide a complete response.`;
  let fallback;
  try {
    fallback = await llm(env, fallbackPrompt);
  } catch (err) {
    fallback = accumulated.domain.at(-1) || `Unable to synthesize an answer: ${err.message}`;
  }
  return finalize(
    'fallback',
    `Below ${CONF_THRESH}% after ${MAX_LOOPS} loops; used LLM fallback.`,
    trace,
    accumulated,
    LLM_FALLBACK_START,
    fallback
  );
}

function finalize(status, reason, trace, accumulated, confidence = null, answer = null) {
  const finalAnswer = answer || 'No answer generated.';
  return {
    status,
    reason,
    confidence: confidence || null,
    trace,
    accumulated,
    answer: finalAnswer,
    response: finalAnswer,
    cards: [{ q: null, r: finalAnswer }],
    timestamp: new Date().toISOString(),
  };
}

// ─── /openrouter-preset — the split-panel inference UI (public/index.html) ───
const PRESETS = {
  'research-journal-v1':
    'You are a research-journal assistant. Produce structured, carefully qualified entries with a summary, evidence, and open questions.',
  'cards-v1': SYSTEM_PROMPT,
};

function systemForPreset(preset) {
  if (!preset) return SYSTEM_PROMPT;
  if (PRESETS[preset]) return PRESETS[preset];
  return `${SYSTEM_PROMPT}\nActive preset: ${preset}.`;
}

async function historyGet(env, contextId) {
  if (!contextId || !env.KV) return [];
  try {
    const raw = await env.KV.get('ctx:' + contextId);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function historyPush(env, contextId, turns) {
  if (!contextId || !env.KV || !turns.length) return;
  try {
    const history = await historyGet(env, contextId);
    const next = history.concat(turns).slice(-20);
    await env.KV.put('ctx:' + contextId, JSON.stringify(next), { expirationTtl: 7 * 24 * 60 * 60 });
  } catch {
    /* history is best-effort */
  }
}

// Translate one OpenRouter SSE data payload into the events the UI understands.
function toUiEvents(chunk, state) {
  const choice = chunk?.choices?.[0] || {};
  const delta = choice.delta || choice.message || {};
  let out = '';

  if (typeof delta.content === 'string' && delta.content) {
    state.assistant += delta.content;
    out += `data: ${JSON.stringify({ type: 'content', content: delta.content })}\n\n`;
  }

  const reasoning = delta.reasoning || delta.reasoning_content;
  if (typeof reasoning === 'string' && reasoning) {
    out += `data: ${JSON.stringify({ type: 'reasoning', content: reasoning })}\n\n`;
  }

  if (delta.tool_calls) {
    out += `data: ${JSON.stringify({ type: 'tool_call', tool_calls: delta.tool_calls })}\n\n`;
  }

  if (choice.finish_reason) {
    out += `data: ${JSON.stringify({ type: 'finish', finish_reason: choice.finish_reason, model: chunk.model || null })}\n\n`;
  }

  return out;
}

async function handlePreset(env, ctx, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: 'Missing "prompt"' }, 400);

  const preset = body.preset || null;
  const contextId = body.context_id || null;
  const stream = body.stream === true;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;

  if (!env.OPENROUTER_API_KEY) {
    const message = 'OPENROUTER_API_KEY is not set on this Worker (add it as a secret: wrangler secret put OPENROUTER_API_KEY)';
    return json({ error: message, response: `⚠️ ${message}` }, 502);
  }

  const history = await historyGet(env, contextId);
  const messages = [
    { role: 'system', content: systemForPreset(preset) },
    ...history,
    { role: 'user', content: prompt },
  ];

  if (!stream) {
    let data;
    try {
      const res = await openRouter(env, { model, messages, tools });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`Model error ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      data = await res.json();
    } catch (e) {
      return json({ error: e.message, response: `⚠️ ${e.message}` }, 502);
    }

    const text = (data?.choices?.[0]?.message?.content || '').trim();
    const reasoning = data?.choices?.[0]?.message?.reasoning || data?.choices?.[0]?.message?.reasoning_content || '';
    if (!text) {
      return json({ error: 'Model returned an empty response', response: '⚠️ Model returned an empty response' }, 502);
    }

    await historyPush(env, contextId, [
      { role: 'user', content: prompt },
      { role: 'assistant', content: text },
    ]);

    return json({
      response: text,
      answer: text,
      reasoning: reasoning || undefined,
      model: data.model || model,
      preset,
      context_id: contextId,
      primary_card: { q: prompt, r: text },
      usage: data.usage || null,
    });
  }

  // Streaming: proxy OpenRouter SSE as {type:'content'|'reasoning'|'tool_call'} events, then [DONE].
  let upstream;
  try {
    upstream = await openRouter(env, { model, messages, tools, stream: true });
  } catch (e) {
    return json({ error: `Model request failed: ${e.message}` }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    return json({ error: `Model error ${upstream.status}${detail ? `: ${detail}` : ''}` }, 502);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  const state = { assistant: '' };
  let buffer = '';

  const readable = new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          ctx.waitUntil(
            historyPush(env, contextId, [
              { role: 'user', content: prompt },
              { role: 'assistant', content: state.assistant },
            ])
          );
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        let out = '';
        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let chunk;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue;
            }
            out += toUiEvents(chunk, state);
          }
        }

        if (out) {
          controller.enqueue(encoder.encode(out));
          return;
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
    },
  });
}

// ─── HTTP entrypoint ───
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/openrouter-preset') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      return handlePreset(env, ctx, request);
    }

    if (url.pathname === '/chat') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      return handleChat(env, request);
    }

    if (url.pathname === '/api/ara/query') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return json({ error: 'Missing "prompt"' }, 400);
      try {
        const result = await process(env, prompt, body.prevTurn, body.url, url.origin);
        return json(result);
      } catch (e) {
        return json({ error: e.message || 'Pipeline failed' }, 502);
      }
    }

    if (url.pathname === '/api/ara/status') {
      return json({ status: 'ok', kv: !!env.KV, model: env.OPENROUTER_MODEL || DEFAULT_MODEL });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  },
};
