// 端到端冒烟：桩 DOM/Canvas/fetch，运行 app.js 全部前端逻辑
const fs = require("fs");

// ---------- Canvas 2D 桩 ----------
function makeCtx() {
  return {
    save(){}, restore(){}, beginPath(){}, closePath(){},
    moveTo(){}, lineTo(){}, arc(){}, rect(){}, fillRect(){}, strokeRect(){},
    fill(){}, stroke(){}, clip(){}, fillText(){}, strokeText(){},
    setLineDash(){}, clearRect(){},
    translate(){}, rotate(){}, scale(){}, setTransform(){},
    measureText(){ return { width: 10 }; },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1,
    textBaseline: "", textAlign: "", lineCap: "",
  };
}

// ---------- 元素桩 ----------
const listeners = new WeakMap();
function fakeEl(tag) {
  const qcache = {};
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    _innerHTML: "",
    get innerHTML(){ return this._innerHTML; },
    set innerHTML(v){ this._innerHTML = v; this.children = []; },
    value: "",
    textContent: "",
    checked: false,
    disabled: false,
    width: 300, height: 150,
    clientWidth: 1000, clientHeight: 560,
    classList: {
      _s: new Set(),
      add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); },
      toggle(c, f){ f ? this._s.add(c) : this._s.delete(c); },
      contains(c){ return this._s.has(c); },
    },
    appendChild(c){ this.children.push(c); return c; },
    addEventListener(t, fn){ if (!listeners.has(this)) listeners.set(this, {}); listeners.get(this)[t] = fn; },
    removeEventListener(){},
    dispatch(t, ev){
      const l = listeners.get(this);
      if (l && l[t]) return l[t](Object.assign({ target: this, currentTarget: this }, ev || {}));
    },
    getContext(){ return makeCtx(); },
    setPointerCapture(){}, releasePointerCapture(){},
    getBoundingClientRect(){ return { left: 0, top: 0, width: 1000, height: 560 }; },
    querySelector(sel){ return qcache[sel] || (qcache[sel] = fakeEl("span")); },
    querySelectorAll(){ return []; },
    closest(){ return null; },
    focus(){}, click(){},
    toDataURL(){ return "data:image/png;base64,AAAA"; },
  };
  return el;
}

const idMap = {};
const idList = ["canvas","summary","rows-body","layout-list","compare-picker",
  "compare-modal","compare-canvas","compare-table","layout-name","layout-note",
  "save-hint","set-rowcount","canvas-tip","btn-report","btn-compare","btn-close-compare",
  "btn-compare-print","btn-clear-compare","btn-save","btn-add-row","btn-apply-rowcount",
  "btn-autogradient","btn-unlock-all","btn-reset"];
idList.forEach((id) => idMap[id] = fakeEl(id.startsWith("btn") ? "button" : "div"));
["set-vy","set-first","set-eye","set-head","set-cgood","set-cmin","set-weye","set-wlen"]
  .forEach((id) => { idMap[id] = fakeEl("input"); idMap[id].value = "1"; });

let openedReport = null;
let windowListeners = {};
globalThis.__opened = { html: null };

global.document = {
  getElementById(id){ return idMap[id] || fakeEl("div"); },
  querySelectorAll(sel){
    if (sel === "[data-bind]")
      return ["set-vy","set-first","set-eye","set-head","set-cgood","set-cmin","set-weye","set-wlen"].map((id) => idMap[id]);
    return [];
  },
  createElement(tag){ return fakeEl(tag); },
};
global.window = {
  devicePixelRatio: 1,
  addEventListener(t, fn){ windowListeners[t] = fn; },
  open(){
    globalThis.__opened.html = null;
    return { document: { open(){}, close(){}, write(html){ globalThis.__opened.html = html; } } };
  },
};
global.localStorage = (() => {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
})();
global.alert = (m) => { console.log("  alert:", m); };
global.confirm = () => true;
global.ResizeObserver = function () { return { observe(){} }; };
global.HTMLCanvasElement = function () {};

let nextId = 1;
const serverStore = new Map();
globalThis.__store = serverStore;
global.fetch = async (path, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  let status = 200, payload;
  if (path === "/api/layouts" && !options.method) {
    payload = { layouts: [...serverStore.values()].sort((a,b) => b.updated_at - a.updated_at) };
  } else if (path === "/api/layouts" && options.method === "POST") {
    const id = nextId++;
    payload = { layout: { id, created_at: 1, updated_at: 2, ...body } };
    serverStore.set(id, payload.layout); status = 201;
  } else if (/^\/api\/layouts\/\d+$/.test(path)) {
    const id = parseInt(path.split("/").pop(), 10);
    if (options.method === "DELETE") { serverStore.delete(id); payload = { deleted: id }; }
    else if (options.method === "PUT") {
      const old = serverStore.get(id);
      const merged = { ...old, ...body, data: body.data || old.data };
      serverStore.set(id, merged); payload = { layout: merged };
    } else {
      payload = { layout: serverStore.get(id) };
    }
  } else { status = 404; payload = { error: "not found" }; }
  return { ok: status < 400, status, json: async () => payload };
};

// ---------- 组装：桩 + app.js + 驱动（同一函数作用域内，strict 词法绑定可访问）----------
const appSrc = fs.readFileSync("/workspace/static/app.js", "utf8");
const driver = fs.readFileSync("/workspace/test_dom_driver.js", "utf8");
const prefix =
  "const idMap=globalThis.__idMap,listeners=globalThis.__listeners,serverStore=globalThis.__store;\n";
const bundle = prefix + appSrc + "\n" + driver + "\n";
globalThis.__idMap = idMap;
globalThis.__listeners = listeners;
fs.writeFileSync("/workspace/.dom_bundle.js", bundle);
require("/workspace/.dom_bundle.js");
