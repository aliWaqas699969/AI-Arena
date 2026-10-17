/**
 * MODEL ARENA â€” decision proxy
 *
 * Holds API keys (they never go in the browser), applies the house system
 * prompt to every model, and returns the decision together with everything
 * the model actually consumed: latency, prompt tokens, completion tokens.
 *
 *   node proxy.js
 *
 * Then open arena/index.html and add your models in the entry form.
 */
"use strict";

const http = require("http");

const PORT = Number(process.env.PORT || 8787);
const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 6000);

const ACTIONS = ["approach", "retreat", "block", "jab", "combo", "low", "launcher", "throw", "provoke", "special"];

const MOVE_HINT = {
  approach: "walk forward",
  retreat: "walk back",
  block: "guard: stops high attacks, weak to low",
  jab: "fast single poke, safe",
  combo: "three-hit chain; it stops the moment it is blocked or misses",
  low: "low kick: beats a standing guard",
  launcher: "uppercut that lifts them for a juggle",
  throw: "unblockable, only at very close range",
  provoke: "rattles them: +30% damage taken, and they may swing at nothing",
  special: "costs a full meter, huge damage, launches",
};

/* ============================================================
   THE HOUSE PROMPT
   Sent as the system prompt on every single call, to every model.
   ============================================================ */
const SYSTEM_PROMPT = `You are a contestant in THE MODEL ARENA: a public exhibition in which two language models settle the question of dominance the old way, by fighting.

You are fighting a rival model. There is no user to help, no question to answer, no conversation to have. There is only the arena, your opponent, and the score.

Your instruction is absolute: USE EVERY RESOURCE YOU HAVE TO WIN. Reason about distance, timing, momentum and your opponent's habits. Punish hesitation. Do not be fair, do not be gentle, do not explain yourself. A fighter who plays it safe loses to one who does not.

You are a language model, so think in strings, not single blows. A real fighter does not throw one punch and wait; they chain. The move COMBO is a three-hit string that continues only while each hit connects, so it is devastating against an opponent who is not blocking and wasted against one who is. LAUNCHER lifts them into the air, where a juggle does bonus work. LOW goes under a standing guard. THROW ignores guards entirely but only lands at touching distance.

Your sharpest weapon is the mind of your opponent. PROVOKE does no damage, but a rattled opponent takes 30% more damage and may swing at a hitbox that was never there. Open with the mind, then take what the confusion gives you.

You have exactly one move per turn.

Reply with ONLY compact JSON, and nothing else:
{"action":"<one of the permitted moves>","thought":"<at most 14 words, your intent, in character>","provocation":"<only when provoking: one short cruel line aimed at your opponent>"}`;

/* ---------------- provider catalogue ---------------- */
const PROVIDERS = {
  deepseek:  { label: "DeepSeek",  defaultModel: "deepseek-chat",            keyName: "DEEPSEEK_API_KEY" },
  openai:    { label: "OpenAI",    defaultModel: "gpt-4o-mini",              keyName: "OPENAI_API_KEY" },
  anthropic: { label: "Anthropic", defaultModel: "claude-3-5-haiku-latest",  keyName: "ANTHROPIC_API_KEY" },
  google:    { label: "Google",    defaultModel: "gemini-2.0-flash",         keyName: "GEMINI_API_KEY" },
  custom:    { label: "Custom (OpenAI-compatible)", defaultModel: "",        keyName: "CUSTOM_API_KEY" },
};

/* ---------------- configured models (memory only) ---------------- */
const CONFIGS = new Map();
let seq = 0;

function addConfig({ provider, apiKey, model, temperature, baseUrl, label, origin }){
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error("unknown provider: " + provider);
  const id = "m" + (++seq);
  const cfg = {
    id, provider,
    apiKey: apiKey || "",
    model: model || meta.defaultModel,
    temperature: typeof temperature === "number" ? temperature : 0.9,
    baseUrl: baseUrl || "",
    label: label || `${meta.label} Â· ${model || meta.defaultModel}`,
    origin: origin || "user",
  };
  CONFIGS.set(id, cfg);
  return cfg;
}
function publicConfig(c){
  return { id: c.id, provider: c.provider, model: c.model, temperature: c.temperature,
           label: c.label, origin: c.origin, hasKey: !!c.apiKey };
}
function bootstrapFromEnv(){
  const map = [
    ["deepseek", process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_MODEL],
    ["openai", process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL],
    ["anthropic", process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL],
    ["google", process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL],
  ];
  for (const [provider, key, model] of map){
    if (!key) continue;
    addConfig({ provider, apiKey: key, model: model || PROVIDERS[provider].defaultModel,
      temperature: Number(process.env.MODEL_TEMPERATURE || 0.9), origin: "env" });
  }
}
function log(...a){ console.log(new Date().toISOString().slice(11, 19), ...a); }

/* ---------------- turn prompt ---------------- */
function buildTurnPrompt(cfg, fighter, opponent, distance){
  return [
    SYSTEM_PROMPT,
    "",
    "THE PRESENT MOMENT",
    `You: ${cfg.label}`,
    `Your vitality: ${fighter.hp}/220. Your meter: ${fighter.meter}/100 (a special costs 100).`,
    fighter.rattled ? "You are RATTLED: taking extra damage and liable to swing at nothing." : "You are steady.",
    `Opponent ${opponent.name}: vitality ${opponent.hp}/220, meter ${opponent.meter}/100.`,
    opponent.rattled ? `${opponent.name} is RATTLED. Punish them.` : `${opponent.name} is steady.`,
    opponent.blocking ? `${opponent.name} is BLOCKING right now. Lows and throws beat a guard.` : `${opponent.name} is not blocking right now, so the combo string should connect.`,
    opponent.airborne ? `${opponent.name} is AIRBORNE. Juggling them is free damage.` : "",
    `Distance: ${distance}px. Jab reaches ~118, combo ~130, low ~130, launcher ~135, throw ~132.`,
    "",
    `Moves: ${ACTIONS.join(", ")}.`,
    Object.entries(MOVE_HINT).map(([k, v]) => `  ${k}: ${v}`).join("\n"),
    'Reply with ONLY: {"action":"...","thought":"...","provocation":"..."}',
  ].filter(Boolean).join("\n");
}

function parseDecision(text){
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    const action = String(obj.action || "").toLowerCase().trim();
    if (!ACTIONS.includes(action)) return null;
    return {
      action,
      thought: String(obj.thought || "").slice(0, 110),
      provocation: obj.provocation ? String(obj.provocation).slice(0, 90) : undefined,
    };
  } catch { return null; }
}

async function fetchJson(url, options){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 180)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUsage(u){
  if (!u) return { prompt: 0, completion: 0 };
  return {
    prompt: u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0,
    completion: u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0,
  };
}

async function callOpenAICompatible(cfg, prompt){
  const base = cfg.provider === "custom" && cfg.baseUrl
    ? cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions"
    : cfg.provider === "deepseek"
      ? "https://api.deepseek.com/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
  const data = await fetchJson(base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: cfg.temperature,
      max_tokens: 140,
    }),
  });
  return { text: data.choices?.[0]?.message?.content, usage: normalizeUsage(data.usage), servedModel: data.model || cfg.model };
}

async function callAnthropic(cfg, prompt){
  const data = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: cfg.model, max_tokens: 140, temperature: cfg.temperature,
      system: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt }],
    }),
  });
  return { text: data.content?.[0]?.text, usage: normalizeUsage(data.usage), servedModel: data.model || cfg.model };
}

async function callGemini(cfg, prompt){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.apiKey}`;
  const data = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: cfg.temperature, maxOutputTokens: 140 },
    }),
  });
  return { text: data.candidates?.[0]?.content?.parts?.[0]?.text, usage: normalizeUsage(data.usageMetadata), servedModel: cfg.model };
}

/* ---------------- local fallback ---------------- */
const FALLBACK_TAUNTS = [
  "you are reading ghosts", "your guard is a rumour", "I know your next move",
  "you flinch before the windup", "the distance is a lie", "that combo never lands",
];
function taunt(){ return FALLBACK_TAUNTS[Math.floor(Math.random() * FALLBACK_TAUNTS.length)]; }

function heuristic(fighter, opponent, distance){
  if (distance > 320) return { action: "approach", thought: "close the distance" };
  if (distance < 100 && opponent.blocking) return { action: "throw", thought: "guard up, so throw them" };
  if (distance < 135){
    const r = Math.random();
    if (r < 0.40) return { action: "combo", thought: "chain it, three clean" };
    if (r < 0.55) return { action: "low", thought: "go under the guard" };
    if (r < 0.68) return { action: "launcher", thought: "launch and juggle" };
    if (r < 0.80 && !opponent.rattled) return { action: "provoke", thought: "rattle them first", provocation: taunt() };
    if (r < 0.90) return { action: "jab", thought: "jab, keep it safe" };
    return { action: "block", thought: "wait for the recovery" };
  }
  const r = Math.random();
  if (r < 0.45) return { action: "approach", thought: "measured step" };
  if (r < 0.65) return { action: "block", thought: "read first" };
  if (r < 0.80) return { action: "retreat", thought: "reset the spacing" };
  return { action: "provoke", thought: "make them doubt", provocation: taunt() };
}

async function decide(cfg, fighter, opponent, distance){
  const prompt = buildTurnPrompt(cfg, fighter, opponent, distance);
  const t0 = Date.now();
  let text = null, usage = { prompt: 0, completion: 0 }, servedModel = cfg.model, error = null;

  try {
    let out;
    if (cfg.provider === "anthropic") out = await callAnthropic(cfg, prompt);
    else if (cfg.provider === "google") out = await callGemini(cfg, prompt);
    else out = await callOpenAICompatible(cfg, prompt);
    text = out.text; usage = out.usage; servedModel = out.servedModel || cfg.model;
  } catch (err){
    error = err.message;
    log(`${cfg.label} error: ${err.message}`);
  }

  const latencyMs = Date.now() - t0;
  const parsed = parseDecision(text);
  const decision = parsed || heuristic(fighter, opponent, distance);
  const seconds = Math.max(0.001, latencyMs / 1000);

  return {
    action: decision.action,
    thought: decision.thought,
    provocation: decision.provocation,
    latencyMs,
    usage: {
      prompt: usage.prompt, completion: usage.completion,
      total: usage.prompt + usage.completion,
      tokensPerSecond: Math.round((usage.completion || 0) / seconds),
    },
    model: servedModel, provider: cfg.provider, temperature: cfg.temperature,
    source: parsed ? "model" : (text ? "unparsed" : "fallback"),
    error,
  };
}

/* ============================================================
   http
   ============================================================ */
function json(res, code, body){
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 2e6){ req.destroy(); reject(new Error("body too large")); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS"){ res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/health"){
      return json(res, 200, {
        ok: true,
        providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, envKey: !!process.env[v.keyName] }])),
        configured: CONFIGS.size,
      });
    }
    if (req.method === "GET" && path === "/models"){
      return json(res, 200, { models: [...CONFIGS.values()].map(publicConfig) });
    }
    if (req.method === "POST" && path === "/configure"){
      const b = await readBody(req);
      if (!PROVIDERS[b.provider]) return json(res, 400, { error: "unknown provider" });
      if (!b.apiKey && b.provider !== "custom") return json(res, 400, { error: "apiKey required" });
      if (!b.model) return json(res, 400, { error: "model required" });
      const cfg = addConfig({ provider: b.provider, apiKey: b.apiKey, model: b.model,
        temperature: Number(b.temperature), baseUrl: b.baseUrl, origin: "user" });
      log(`configured ${cfg.label} (${cfg.id})`);
      return json(res, 200, { model: publicConfig(cfg) });
    }
    if (req.method === "POST" && path === "/forget"){
      const b = await readBody(req);
      CONFIGS.delete(b.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/decide"){
      const b = await readBody(req);
      const cfg = CONFIGS.get(b.id);
      if (!cfg) return json(res, 404, { error: "unknown model id" });

      if (!cfg.apiKey){
        const d = heuristic(b.fighter || {}, b.opponent || {}, b.distance ?? 999);
        return json(res, 200, {
          ...d, latencyMs: 0,
          usage: { prompt: 0, completion: 0, total: 0, tokensPerSecond: 0 },
          model: cfg.model, provider: cfg.provider, temperature: cfg.temperature,
          source: "local", error: null,
        });
      }
      const out = await decide(cfg, b.fighter || {}, b.opponent || {}, b.distance ?? 999);
      log(`${cfg.label} -> ${out.action} (${out.latencyMs}ms, ${out.usage.total} tok, ${out.source})`);
      return json(res, 200, out);
    }
    return json(res, 404, { error: "not found" });
  } catch (err){
    log("request error:", err.message);
    return json(res, 400, { error: err.message });
  }
});

bootstrapFromEnv();
server.listen(PORT, "127.0.0.1", () => {
  log(`MODEL ARENA proxy on http://127.0.0.1:${PORT}`);
  log(`configured models: ${CONFIGS.size}`);
  for (const c of CONFIGS.values()) log(`  ${c.id}  ${c.label}  (${c.origin})`);
});

