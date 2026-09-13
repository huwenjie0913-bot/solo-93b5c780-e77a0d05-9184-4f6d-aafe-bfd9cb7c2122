// 拼接 浏览器桩 + app.js(纯计算部分) + 测试主体 后运行
const fs = require("fs");
let src = fs.readFileSync("/workspace/static/app.js", "utf8");
src = src.split("function init()")[0];

const stub = `
const noop = () => {};
function makeCtx() {
  return new Proxy({}, { get: (t, k) => {
    if (k === "canvas") return {};
    return (...a) => makeCtxVal;
  }, set: () => true });
}
const makeCtxVal = function () {};
const stubEl = {
  getContext: () => makeCtx(),
  addEventListener: noop, removeEventListener: noop,
  setPointerCapture: noop, releasePointerCapture: noop,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, querySelector: () => stubEl, querySelectorAll: () => [],
  addEventListener2: noop,
};
const handler = {
  get(t, k) {
    if (k === "getContext") return () => makeCtx();
    if (typeof stubEl[k] !== "undefined") return stubEl[k];
    return "";
  },
  set() { return true; }
};
const elProxy = new Proxy(stubEl, handler);
global.document = {
  getElementById: () => elProxy,
  querySelectorAll: () => [],
  createElement: () => elProxy,
};
global.window = { devicePixelRatio: 1, addEventListener: noop };
global.localStorage = { getItem: () => null, setItem: noop };
global.alert = noop; global.confirm = () => true;
global.ResizeObserver = function () { return { observe: noop }; };
global.HTMLCanvasElement = function () {};
global.fetch = noop;
`;

const body = fs.readFileSync("/workspace/test_body.js", "utf8");
fs.writeFileSync("/workspace/.test_bundle.js", stub + "\n" + src + "\n" + body);
require("/workspace/.test_bundle.js");
