// Soak test: runs the arena headlessly for N seconds and reports state + errors.
const fs = require("fs"), path = require("path"), vm = require("vm");
const { createDocument } = require("./domstub");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

let clock = 0;
const STEP = 1000 / 60;
const SECS = Number(process.argv[2] || 120);

const grad = { addColorStop(){} };
const canvas = { width: 0, height: 0, getContext: () => ctxStub, style: {} };
const ctxStub = new Proxy({}, {
  get(t, k){
    if (k === "createLinearGradient" || k === "createRadialGradient") return () => grad;
    if (k === "measureText") return s => ({ width: String(s).length * 7 });
    if (k === "canvas") return canvas;
    return () => undefined;
  },
  set(){ return true; },
});

let rafQueue = [], pendingTimers = [], errs = [];
const perf = { now: () => clock };
global.document = createDocument(canvas);
global.window = { devicePixelRatio: 1, addEventListener(){} };
global.requestAnimationFrame = fn => { rafQueue.push(fn); };
global.performance = perf;
global.setTimeout = (fn, ms) => { pendingTimers.push({ fn, at: clock + ms }); };
global.fetch = () => Promise.reject(new Error("offline"));
global.location = { search: "" };
global.Event = class Event { constructor(t){ this.type = t; } };

const sb = {
  document: global.document, window: global.window, location: global.location,
  requestAnimationFrame: global.requestAnimationFrame, performance: perf,
  setTimeout: global.setTimeout, fetch: global.fetch, Event: global.Event,
  console, Math, Date, Object, Array, String, Number, parseInt, parseFloat, isNaN, RegExp, Promise, URL,
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "index.html:script" });

const A = sb.window.ARENA;
const tick = () => new Promise(r => setImmediate(r));

async function run(){
  for (let i = 0; i < 6; i++) await tick();

  A.startMatch([
    { kind: "demo", label: "DEMO · BLUE",  provider: "demo", model: "local engine", temperature: 0 },
    { kind: "demo", label: "DEMO · AMBER", provider: "demo", model: "local engine", temperature: 0 },
  ]);

  const states = { ko: 0, stun: 0, pending: 0, action: 0, idle: 0, over: 0 };
  const decisions = [0, 0];
  const last = [{ obj: null, n: 0 }, { obj: null, n: 0 }];
  let frames = 0, rounds = 0, lastOver = false;

  while (frames < SECS * 60){
    clock += STEP; frames++;
    for (let i = pendingTimers.length - 1; i >= 0; i--){
      if (pendingTimers[i].at <= clock){
        const t = pendingTimers[i]; pendingTimers.splice(i, 1);
        try { t.fn(); } catch(e){ errs.push("timer: " + e.message); }
      }
    }
    const q = rafQueue; rafQueue = [];
    if (!q.length){ console.log("LOOP DIED at frame", frames); break; }
    for (const fn of q){ try { fn(clock); } catch(e){ errs.push("frame: " + e.message); } }
    await tick();

    const g = A.game;
    // the results sheet waits for the player; simulate pressing Rematch
    if (g.resultShown) A.startMatch(g.fighters.map(f => f.def));

    if (g.over && !lastOver) rounds++;
    lastOver = g.over;

    g.fighters.forEach((f, i) => {
      // fighters are recreated on each replay, so track per-object
      if (last[i].obj !== f){ last[i] = { obj: f, n: 0 }; }
      if (f.stats.decisions > last[i].n){
        decisions[i] += f.stats.decisions - last[i].n;
        last[i].n = f.stats.decisions;
      }
      if (g.over){ states.over++; return; }
      if (f.ko){ states.ko++; return; }
      if (f.stun > 0){ states.stun++; return; }
      if (f.action){ states.action++; return; }
      if (f.pending){ states.pending++; return; }
      states.idle++;
    });
  }

  const total = Object.values(states).reduce((a, b) => a + b, 0) || 1;
  console.log("=== " + SECS + "s | rounds: " + rounds + " | frames: " + frames + " ===");
  for (const k in states) console.log("  " + k.padEnd(8), (100 * states[k] / total).toFixed(1) + "%");
  console.log("decisions:", decisions.join(" / "), "->", (decisions[0] / SECS).toFixed(2), "per sec per fighter");
  console.log("series:", JSON.stringify(A.game.series));
  console.log("errors:", errs.length);
  [...new Set(errs)].slice(0, 8).forEach(e => console.log("  !", e));
}

run();
