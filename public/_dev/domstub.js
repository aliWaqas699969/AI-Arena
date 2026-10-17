// Minimal DOM stub so the arena's setup/UI code can run headlessly.
class El {
  constructor(tag){
    this.tagName = tag || "div";
    this.value = "";
    this.textContent = "";
    this.placeholder = "";
    this.style = {};
    this._cls = new Set();
    this.classList = {
      add: c => this._cls.add(c),
      remove: c => this._cls.delete(c),
      contains: c => this._cls.has(c),
      toggle: (c, on) => {
        if (on === undefined) this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c);
        else on ? this._cls.add(c) : this._cls.delete(c);
      },
    };
  }
  set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className(){ return [...this._cls].join(" "); }
  set innerHTML(v){ this._html = v; }
  get innerHTML(){ return this._html || ""; }
  addEventListener(){}
  removeEventListener(){}
  dispatchEvent(){}
  querySelector(){ return new El("div"); }
  querySelectorAll(){ return []; }
  appendChild(){}
}

function createDocument(canvas){
  const cache = new Map();
  const byId = new Map();
  const doc = {
    getElementById(id){
      if (id === "stage") return canvas;
      if (!byId.has(id)) byId.set(id, new El("div"));
      return byId.get(id);
    },
    querySelector(sel){
      if (!cache.has(sel)) cache.set(sel, new El("div"));
      return cache.get(sel);
    },
    querySelectorAll(){ return []; },
    createElement(tag){ return new El(tag); },
    addEventListener(){},
  };
  return doc;
}

module.exports = { El, createDocument };
