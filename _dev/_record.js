// Runs the real game code headlessly against a recording canvas, then writes
// one frame's draw calls to frame_<T>.json for the Python rasterizer.
const fs = require("fs"), path = require("path"), vm = require("vm");
const { createDocument } = require("./domstub");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

let clock = 0;
const STEP = 1000 / 60;
const TARGET = Number(process.argv[2] || 7000);

// ---------- recording canvas ----------
let ops = [], allOps = [], recording = false;
let M = [1, 0, 0, 1, 0, 0], stack = [];
const mul = (m, n) => [
  m[0]*n[0] + m[2]*n[1], m[1]*n[0] + m[3]*n[1],
  m[0]*n[2] + m[2]*n[3], m[1]*n[2] + m[3]*n[3],
  m[0]*n[4] + m[2]*n[5] + m[4], m[1]*n[4] + m[3]*n[5] + m[5],
];
const tp = (x, y) => [M[0]*x + M[2]*y + M[4], M[1]*x + M[3]*y + M[5]];
const scaleOf = () => Math.sqrt(Math.abs(M[0]*M[3] - M[1]*M[2])) || 1;

let path_ = [], cur = null;
let style = "#000", strokeStyle = "#000", lineWidth = 1, alpha = 1;
let font = "12px sans-serif", align = "left", baseline = "alphabetic";
let grads = {}, gradSeq = 0;

const grad = (x0, y0, r0, x1, y1, r1, id) => ({
  __grad: true, id,
  addColorStop(o, c){
    (grads[id] = grads[id] || { x0, y0, r0, x1, y1, r1, stops: [] }).stops.push([o, c]);
  },
});

function enc(v){
  if (v && v.__grad){
    const g = grads[v.id];
    return { grad: g ? { x0: g.x0, y0: g.y0, r0: g.r0, x1: g.x1, y1: g.y1, r1: g.r1, stops: g.stops.slice() } : null };
  }
  return String(v);
}

function makeCtx(){
  return {
    get canvas(){ return canvas; },
    setTransform(a, b, c, d, e, f){ M = [a, b, c, d, e, f]; },
    save(){
      stack.push({ M: M.slice(), style, strokeStyle, lineWidth, alpha, font, align, baseline });
      if (recording) ops.push({ t: "save" });
    },
    restore(){
      const s = stack.pop();
      if (s){
        M = s.M; style = s.style; strokeStyle = s.strokeStyle; lineWidth = s.lineWidth;
        alpha = s.alpha; font = s.font; align = s.align; baseline = s.baseline;
      } else {
        M = [1, 0, 0, 1, 0, 0];
      }
      if (recording) ops.push({ t: "restore" });
    },
    translate(x, y){ M = mul(M, [1, 0, 0, 1, x, y]); },
    scale(x, y){ M = mul(M, [x, 0, 0, y, 0, 0]); },
    rotate(a){ M = mul(M, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },

    get fillStyle(){ return style; }, set fillStyle(v){ style = v; },
    get strokeStyle(){ return strokeStyle; }, set strokeStyle(v){ strokeStyle = v; },
    get lineWidth(){ return lineWidth; }, set lineWidth(v){ lineWidth = v; },
    get globalAlpha(){ return alpha; }, set globalAlpha(v){ alpha = v; },
    get font(){ return font; }, set font(v){ font = v; },
    get textAlign(){ return align; }, set textAlign(v){ align = v; },
    get textBaseline(){ return baseline; }, set textBaseline(v){ baseline = v; },
    get shadowColor(){ return ""; }, set shadowColor(v){},
    get shadowBlur(){ return 0; }, set shadowBlur(v){},
    get lineCap(){ return "round"; }, set lineCap(v){},
    get letterSpacing(){ return "0px"; }, set letterSpacing(v){},

    createLinearGradient(x0, y0, x1, y1){ return grad(x0, y0, 0, x1, y1, 0, "g" + (++gradSeq)); },
    createRadialGradient(x0, y0, r0, x1, y1, r1){ return grad(x0, y0, r0, x1, y1, r1, "g" + (++gradSeq)); },

    beginPath(){ path_ = []; cur = null; },
    moveTo(x, y){ cur = { pts: [tp(x, y)], closed: false }; path_.push(cur); },
    lineTo(x, y){ if (!cur) this.moveTo(x, y); else cur.pts.push(tp(x, y)); },
    closePath(){ if (cur) cur.closed = true; },
    arcTo(x1, y1){ if (cur) cur.pts.push(tp(x1, y1)); },
    arc(x, y, r, a0, a1){
      const pts = [], n = 28;
      for (let i = 0; i <= n; i++){
        const a = a0 + (a1 - a0) * (i / n);
        pts.push(tp(x + Math.cos(a) * r, y + Math.sin(a) * r));
      }
      if (!cur){ cur = { pts: [], closed: false }; path_.push(cur); }
      cur.pts = cur.pts.concat(pts);
    },
    ellipse(x, y, rx, ry){
      const pts = [], n = 32;
      for (let i = 0; i <= n; i++){
        const a = (i / n) * Math.PI * 2;
        pts.push(tp(x + Math.cos(a) * rx, y + Math.sin(a) * ry));
      }
      if (!cur){ cur = { pts: [], closed: false }; path_.push(cur); }
      cur.pts = cur.pts.concat(pts);
    },
    rect(x, y, w, h){
      path_ = [{ pts: [tp(x,y), tp(x+w,y), tp(x+w,y+h), tp(x,y+h)], closed: true }];
      cur = path_[0];
    },
    fill(){ if (recording) ops.push({ t: "fill", paths: path_.map(p => ({ pts: p.pts, closed: p.closed })), style: enc(style), alpha }); },
    stroke(){ if (recording) ops.push({ t: "stroke", paths: path_.map(p => ({ pts: p.pts, closed: p.closed })), style: enc(strokeStyle), w: lineWidth * scaleOf(), alpha }); },
    fillRect(x, y, w, h){ if (recording) ops.push({ t: "rect", x: tp(x,y), w: w*M[0], h: h*M[3], style: enc(style), alpha }); },
    strokeRect(x, y, w, h){ if (recording) ops.push({ t: "strokeRect", x: tp(x,y), w: w*M[0], h: h*Math.abs(M[3]), style: enc(strokeStyle), w: lineWidth, alpha }); },
    fillText(s, x, y){
      if (!recording) return;
      const p = tp(x, y);
      const mm = font.match(/(\d+(?:\.\d+)?)px/);
      const size = (mm ? parseFloat(mm[1]) : 12) * scaleOf();
      const wm = font.match(/([1-9]00)\s/);
      const weight = wm ? +wm[1] : 400;
      ops.push({ t: "text", s: String(s), x: p[0], y: p[1], size, weight, align, baseline, style: enc(style), alpha });
    },
    measureText(s){
      const mm = font.match(/(\d+(?:\.\d+)?)px/);
      const size = mm ? parseFloat(mm[1]) : 12;
      return { width: String(s).length * size * 0.5 };
    },
    setLineDash(){},
  };
}

const canvas = { width: 0, height: 0, getContext: () => ctxStub, style: {} };
const ctxStub = makeCtx();

// ---------- environment ----------
let rafQueue = [], pendingTimers = [], errs = [];
const perf = { now: () => clock };
const document = createDocument(canvas);

global.document = document;
global.window = { devicePixelRatio: 1, addEventListener(){} };
global.requestAnimationFrame = fn => { rafQueue.push(fn); };
global.performance = perf;
global.setTimeout = (fn, ms) => { pendingTimers.push({ fn, at: clock + ms }); };
global.fetch = () => Promise.reject(new Error("offline"));
global.location = { search: "" };
global.Event = class Event { constructor(t){ this.type = t; } };

const sb = {
  document, window: global.window, location: global.location,
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
  // let boot() finish (it awaits the model list)
  for (let i = 0; i < 6; i++) await tick();

  A.startMatch([
    { kind: "demo", label: "DEMO · BLUE",  provider: "demo", model: "local engine", temperature: 0 },
    { kind: "demo", label: "DEMO · AMBER", provider: "demo", model: "local engine", temperature: 0 },
  ]);

  let frames = 0;
  while (clock < TARGET && frames < 1600){
    clock += STEP; frames++;
    for (let i = pendingTimers.length - 1; i >= 0; i--){
      if (pendingTimers[i].at <= clock){
        const t = pendingTimers[i]; pendingTimers.splice(i, 1);
        try { t.fn(); } catch(e){ errs.push(e.message); }
      }
    }
    ops = []; recording = true;
    const q = rafQueue; rafQueue = [];
    if (!q.length){ console.log("loop not running"); break; }
    for (const fn of q){ try { fn(clock); } catch(e){ errs.push(e.message); } }
    await tick();
    recording = false;
    allOps = ops;
  }

  fs.writeFileSync(path.join(__dirname, "frame_" + TARGET + ".json"), JSON.stringify({ ops: allOps }));
  console.log("frames:", frames, "ops:", allOps.length, "errors:", errs.length);
  console.log("fighters:", A.game.fighters.map(f => `${f.name}(hp${Math.round(f.hp)})`).join(" vs "));
  errs.slice(0, 6).forEach(e => console.log("  !", e));
}

run();
