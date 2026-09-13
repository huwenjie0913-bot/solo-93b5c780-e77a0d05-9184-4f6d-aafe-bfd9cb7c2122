
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

/* ============================================================
   观众席视线校核台 —— 前端逻辑
   纯原生 JS：Canvas 2D 绘图 + DOM API + fetch(JSON)
   ============================================================ */
"use strict";

/* ---------------- 常量与默认值 ---------------- */

const STORAGE_KEY = "sightline_state_v1";

const RISK = {
  GOOD: "good",       // C ≥ 目标值
  WARN: "warn",       // 最低限 ≤ C < 目标值
  BAD: "bad",         // 0 ≤ C < 最低限：视点可见但头顶净空不足
  BLOCK: "block",     // C < 0：视点被遮挡
  AISLE: "aisle",     // 通道，不参与遮挡
};
const RISK_LABEL = { good: "合格", warn: "偏差", bad: "遮挡风险", block: "已遮挡", aisle: "通道" };
const RISK_COLOR = {
  good:  "#2ea86f",
  warn:  "#e09a1a",
  bad:   "#e05a38",
  block: "#c0271f",
  aisle: "#8ea0b8",
};
const COMPARE_COLORS = ["#2f6fd0", "#8a4fd0", "#0f9d8c", "#d07a1f"];

const DEFAULTS = {
  settings: {
    vy: 0.60,            // 视点高度（舞台面以上 m）
    firstDistance: 4.50, // 首排眼位距 V 的水平距离
    eyeHeight: 1.15,     // 坐姿眼高
    headHeight: 1.30,    // 坐姿头顶高
    cGood: 0.12,         // C 值目标
    cMin: 0.06,          // C 值最低限
    wheelEye: 1.15,      // 轮椅眼高
    wheelLength: 1.20,   // 轮椅占位长度
  },
};

function sampleRows() {
  // 小剧场示例：前 4 排为已建固定台阶（前两排锁定），中间一条横向通道，
  // 后排平台待起坡，其中一排为轮椅位。
  const mk = (type, depth, elev, locked = false) => ({ type, depth, elev, locked });
  return [
    mk("seat", 0.85, 0.00, true),
    mk("seat", 0.85, 0.08, true),
    mk("seat", 0.85, 0.16, false),
    mk("seat", 0.85, 0.24, false),
    mk("aisle", 1.20, 0.24, false),
    mk("wheel", 0.90, 0.24, false),
    mk("seat", 0.90, 0.24, false),
    mk("seat", 0.90, 0.24, false),
    mk("seat", 0.90, 0.24, false),
  ];
}

/* ---------------- 小工具 ---------------- */

const $ = (id) => document.getElementById(id);

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function r2(v) { return v === null || v === undefined || Number.isNaN(v) ? "—" : (Math.round(v * 100) / 100).toFixed(2); }
function r3(v) { return v === null || v === undefined || Number.isNaN(v) ? "—" : (Math.round(v * 1000) / 1000).toFixed(3); }
function num(el, fallback) {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 状态 ---------------- */

let state = loadState();
let selected = -1;            // 当前选中排
let savedId = null;           // 已载入/已保存的服务器布置 id
let layoutsCache = [];        // 服务器布置列表
let compareIds = [];          // 叠加比较的布置 id
let view = null;              // 最近一次绘制的坐标变换（供命中测试）

function freshState() {
  return {
    name: "",
    note: "",
    settings: { ...DEFAULTS.settings },
    rows: sampleRows(),
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.rows)) {
        return {
          name: obj.name || "",
          note: obj.note || "",
          settings: { ...DEFAULTS.settings, ...(obj.settings || {}) },
          rows: obj.rows.map(normRow),
        };
      }
    }
  } catch (e) { /* 忽略损坏缓存 */ }
  return freshState();
}

function normRow(r) {
  return {
    type: ["seat", "wheel", "aisle"].includes(r.type) ? r.type : "seat",
    depth: Number.isFinite(r.depth) ? r.depth : 0.9,
    elev: Number.isFinite(r.elev) ? r.elev : 0,
    locked: !!r.locked && r.type !== "aisle",
  };
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 配额满忽略 */ }
}

/* ============================================================
   核心计算
   ============================================================ */

function isOcc(r) { return r.type === "seat" || r.type === "wheel"; }

function effEyeOf(s, type) { return type === "wheel" ? s.wheelEye : s.eyeHeight; }
// 轮椅只另给眼高，头眼高差沿用普通坐姿
function effHeadOf(s, type) {
  return effEyeOf(s, type) + (s.headHeight - s.eyeHeight);
}

function compute(s, rows) {
  // ---- 水平位置：每排进深 D_n 为该排自身占地（踏面）宽度，眼位在其中点 ----
  // 首排前缘 a0 = firstDistance - D0/2；第 n 排前后缘 a_n、a_n+D_n，
  // 眼位 x_n = a_n + D_n/2。等进深时 x_n = firstDistance + n·D。
  const dxs = [];
  rows.forEach((r, i) => { dxs.push(i === 0 ? s.firstDistance - r.depth / 2 : dxs[i - 1] + rows[i - 1].depth); });
  const xs = dxs.map((a, i) => a + rows[i].depth / 2);
  const totalDepth = rows.length ? dxs[0] + rows.reduce((t, r) => t + r.depth, 0) : s.firstDistance;

  // ---- 通道楼面：相邻有效排之间线性插值 ----
  const occIdx = rows.map((r, i) => isOcc(r) ? i : -1).filter((i) => i >= 0);
  const floors = rows.map((r, i) => {
    if (isOcc(r)) return r.elev;
    let prev = -1, next = -1;
    for (const k of occIdx) { if (k < i) prev = k; if (k > i && next < 0) next = k; }
    if (prev >= 0 && next >= 0) {
      return rows[prev].elev +
        (rows[next].elev - rows[prev].elev) * (xs[i] - xs[prev]) / (xs[next] - xs[prev]);
    }
    if (prev >= 0) return rows[prev].elev;
    if (next >= 0) return rows[next].elev;
    return 0;
  });

  const list = rows.map((r, i) => {
    const x = xs[i];
    const floor = floors[i];
    const occupied = isOcc(r);
    const effEye = occupied ? effEyeOf(s, r.type) : null;
    const effHead = occupied ? effHeadOf(s, r.type) : null;
    return { ...r, i, x: xs[i], floor, occupied,
      eyeY: occupied ? floor + effEye : null,
      headY: occupied ? floor + effHead : null,
      c: null, worst: -1, blockedH: 0, rayY0: null, risk: RISK.AISLE };
  });

  // ---- 逐排视线校核（统一几何口径）----
  // 第 n 排观众的视线为 E_n(x_n,eyeY_n) → V(0,vy)。对每一先前有效排 j，
  // 该视线在“遮挡平面” x_j（前排头顶所在平面）处的高度：
  //   yS_j = vy + (eyeY_n-vy)·x_j/x_n
  // 头顶平面净空（C 值）= yS_j − headY_j，取全部前排中的最小值为本排 C 值。
  // 因此 C 值、自动起坡、风险判定、图示均以遮挡平面处净空为准。
  for (const cur of list) {
    if (!cur.occupied) continue;
    let best = Infinity, bestJ = -1;
    for (const j of list) {
      if (!j.occupied || j.i >= cur.i) break;
      const yS = s.vy + (cur.eyeY - s.vy) * j.x / cur.x;
      const c = yS - j.headY;
      if (c < best) { best = c; bestJ = j.i; }
    }
    if (bestJ < 0) { cur.risk = RISK.GOOD; continue; } // 首排（无前排）
    cur.c = best; cur.worst = bestJ;
    const j = list[bestJ];

    // 观众视线擦过 j 排头顶 E_n→H_j 延伸到舞台平面 x=0 处的高度 y0，
    // 舞台面上 0～y0 即为该排被遮挡范围（遮挡平面净空为负时 V 本身不可见）。
    const slope = (j.headY - cur.eyeY) / (j.x - cur.x);
    cur.rayY0 = cur.eyeY + slope * (0 - cur.x);
    cur.blockedH = Math.max(0, cur.rayY0);

    // 风险判定带 2mm 工程容差，吸收楼面毫米取整/浮点误差；
    // 真正不达标（如 0.1008 对 0.12）仍按偏差/风险处理。
    const TOL = 0.002;
    if (best < -TOL) cur.risk = RISK.BLOCK;
    else if (best < s.cMin - TOL) cur.risk = RISK.BAD;
    else if (best < s.cGood - TOL) cur.risk = RISK.WARN;
    else cur.risk = RISK.GOOD;
  }

  const counts = { good: 0, warn: 0, bad: 0, block: 0, aisle: 0, seat: 0, wheel: 0 };
  let maxElev = -Infinity, maxEye = -Infinity, minFloor = Infinity, worstC = Infinity;
  for (const r of list) {
    counts[r.risk]++;
    if (r.type === "seat") counts.seat++;
    if (r.type === "wheel") counts.wheel++;
    maxElev = Math.max(maxElev, r.floor);
    minFloor = Math.min(minFloor, r.floor);
    if (r.occupied) maxEye = Math.max(maxEye, r.eyeY);
    if (r.c !== null) worstC = Math.min(worstC, r.c);
  }

  return {
    list, xs, dxs, totalDepth,
    maxElev: list.length ? maxElev : 0,
    minFloor: list.length ? minFloor : 0,
    maxEye: list.length ? maxEye : s.eyeHeight,
    counts, worstC: worstC === Infinity ? null : worstC,
  };
}

/* 自动起坡：自首个有效排起逐排保证 C≥目标值；锁定排保持原标高并作为后续切线依据；
   通道排在有效排之间插值。 */
function autoGradient() {
  const s = state.settings, rows = state.rows;
  const dxs = [];
  rows.forEach((r, i) => { dxs.push(i === 0 ? s.firstDistance - r.depth / 2 : dxs[i - 1] + rows[i - 1].depth); });
  const xs = dxs.map((a, i) => a + rows[i].depth / 2);
  const firstOcc = rows.findIndex(isOcc);
  if (firstOcc < 0) return;

  // 对每个未锁定有效排：由遮挡平面净空口径反求所需眼位。
  // 要求对每个先前有效排 j：vy + (eye_i−vy)·x_j/x_i ≥ head_j + cGood
  //   → eye_i ≥ vy + (head_j + cGood − vy)·x_i/x_j，取最大者。
  // 楼面标高按毫米向上取整；因前排楼面本身也已取整，需迭代复算直到
  // 用“取整后的楼面”校核时全部有效排 C≥cGood（通常两轮收敛）。
  const elevNeed = (r, i) => {
    let need = -Infinity;
    for (let j = 0; j < i; j++) {
      if (!isOcc(rows[j])) continue;
      const headJ = rows[j].elev + effHeadOf(s, rows[j].type);
      need = Math.max(need, s.vy + (headJ + s.cGood - s.vy) * xs[i] / xs[j]);
    }
    return need;
  };
  for (let iter = 0; iter < 3; iter++) {
    let changed = false;
    rows.forEach((r, i) => {
      if (!isOcc(r) || i === firstOcc || r.locked) return;
      const need = elevNeed(r, i);
      const elevC = Math.ceil((need - effEyeOf(s, r.type)) * 1000 - 1e-9) / 1000;
      if (elevC > r.elev + 1e-9) { r.elev = elevC; changed = true; }
    });
    if (!changed) break;
  }

  // 通道插值
  const occIdx = rows.map((r, i) => isOcc(r) ? i : -1).filter((i) => i >= 0);
  rows.forEach((r, i) => {
    if (isOcc(r)) return;
    let prev = -1, next = -1;
    for (const k of occIdx) { if (k < i) prev = k; if (k > i && next < 0) next = k; }
    if (prev >= 0 && next >= 0) {
      r.elev = rows[prev].elev +
        (rows[next].elev - rows[prev].elev) * (xs[i] - xs[prev]) / (xs[next] - xs[prev]);
    } else if (prev >= 0) r.elev = rows[prev].elev;
    else if (next >= 0) r.elev = rows[next].elev;
  });
}

/* ============================================================
   Canvas 剖面图绘制
   ============================================================ */

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

/* 计算多套数据共同的世界坐标范围与变换 */
function buildView(box, datasets) {
  const { W, H } = box;
  let xmax = 1, ymax = 1.2, ymin = -0.5, minFloor = 0;
  for (const ds of datasets) {
    xmax = Math.max(xmax, ds.res.totalDepth);
    ymax = Math.max(ymax, ds.settings.vy, ds.res.maxEye);
    ymin = Math.min(ymin, ds.settings.vy, ds.res.minFloor);
    minFloor = Math.min(minFloor, ds.res.minFloor);
  }
  const stageW = clamp(xmax * 0.12, 1.2, 3.0);
  ymin = Math.min(-0.45, minFloor - 0.95);   // 底部留尺寸线空间
  ymax += 0.9;
  const xmin = -stageW - 0.2, xr = xmax + 0.9;
  const pad = 18;
  const sc = Math.min((W - pad * 2) / (xr - xmin), (H - pad * 2) / (ymax - ymin));
  const ox = pad + (-xmin) * sc;             // x=0（V 轴）的屏幕 x
  const P = (x, y) => [ox + x * sc, H - pad - (y - ymin) * sc];
  return { W, H, pad, sc, ox, xmin, xmax: xr, ymin, ymax, stageW, P };
}

function drawScene(canvasEl, datasets, opts) {
  opts = opts || {};
  const c = canvasEl.getContext("2d");
  const dpr = opts.dpr || (window.devicePixelRatio || 1);
  const cssW = opts.width || canvasEl.clientWidth, cssH = opts.height || canvasEl.clientHeight;
  if (canvasEl.width !== Math.round(cssW * dpr)) canvasEl.width = Math.round(cssW * dpr);
  if (canvasEl.height !== Math.round(cssH * dpr)) canvasEl.height = Math.round(cssH * dpr);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = buildView({ W: cssW, H: cssH }, datasets);
  const P = v.P;
  c.clearRect(0, 0, cssW, cssH);
  c.fillStyle = "#fbfbf8"; c.fillRect(0, 0, cssW, cssH);

  drawGrid(c, v);
  drawStage(c, v, datasets[0].settings.vy);

  datasets.forEach((ds, di) => {
    const primary = di === 0;
    c.globalAlpha = primary ? 1 : (opts.compareAlpha != null ? opts.compareAlpha : 0.75);
    drawProfile(c, v, ds, {
      primary,
      color: ds.color || "#33415c",
      selected: primary ? selected : -1,
      showPeople: primary && !opts.noPeople,
      showLines: primary && !opts.noLines,
      showHandles: primary && opts.interactive,
      showLabels: primary,
      interactive: !!opts.interactive && primary,
    });
    c.globalAlpha = 1;
  });

  drawRuler(c, v, datasets[0]);
  if (opts.interactive) drawHandles(c, v, datasets[0]);
  return v;
}

function drawGrid(c, v) {
  const [x0, y0] = v.P(v.xmin, v.ymin), [x1, y1] = v.P(v.xmax, v.ymax);
  c.strokeStyle = "#e6e9ee"; c.lineWidth = 1; c.font = "9px sans-serif"; c.fillStyle = "#9aa6b5";
  const step = 1;
  for (let gx = Math.ceil(v.xmin); gx <= v.xmax; gx += step) {
    const [sx] = v.P(gx, 0);
    c.beginPath(); c.moveTo(sx, y1); c.lineTo(sx, y0); c.stroke();
  }
  for (let gy = Math.ceil(v.ymin); gy <= v.ymax; gy += step) {
    const [, sy] = v.P(0, gy);
    c.beginPath(); c.moveTo(x0, sy); c.lineTo(x1, sy); c.stroke();
    c.fillText(gy + "m", 4, sy - 2);
  }
  // 舞台面基准 y=0
  const [, sy0] = v.P(0, 0);
  c.strokeStyle = "#c2cad6"; c.lineWidth = 1.4;
  c.beginPath(); c.moveTo(x0, sy0); c.lineTo(x1, sy0); c.stroke();
}

function drawStage(c, v, vy) {
  const [lx, ty] = v.P(-v.stageW, 0);
  const [rx, by] = v.P(0, -0.55);
  c.fillStyle = "#ded7c8"; c.fillRect(lx, ty, rx - lx, by - ty);
  c.strokeStyle = "#a99c84"; c.strokeRect(lx, ty, rx - lx, by - ty);
  // 台面斜线填充
  c.save(); c.beginPath(); c.rect(lx, ty, rx - lx, by - ty); c.clip();
  c.strokeStyle = "rgba(150,138,114,.45)"; c.lineWidth = 1;
  for (let s = lx - (by - ty); s < rx + 20; s += 9) {
    c.beginPath(); c.moveTo(s, by); c.lineTo(s + (by - ty), ty); c.stroke();
  }
  c.restore();
  c.fillStyle = "#7c705c"; c.font = "bold 12px sans-serif";
  c.fillText("舞台", lx + 10, ty + 18);
  // V 轴虚线
  const [vx, vyS] = v.P(0, vy);
  c.setLineDash([4, 3]); c.strokeStyle = "#c64b3c"; c.lineWidth = 1;
  c.beginPath(); c.moveTo(vx, ty); c.lineTo(vx, vyS); c.stroke();
  c.setLineDash([]);
  c.fillStyle = "#a8412f"; c.font = "10px sans-serif";
  c.fillText("视点高 " + r2(vy), vx + 5, (ty + vyS) / 2);
}

/* 单套剖面 */
function drawProfile(c, v, ds, o) {
  const { res, settings } = ds;
  const L = res.list;
  if (!L.length) return;
  const color = o.color;

  // ---- 楼板阶梯轮廓（每排占地前后缘）----
  const bounds = res.dxs.map((a, i) => a);
  bounds.push(res.totalDepth);

  c.beginPath();
  c.moveTo(...v.P(0, 0)); c.lineTo(...v.P(bounds[0], 0));
  L.forEach((row, i) => {
    c.lineTo(...v.P(bounds[i], row.floor));
    c.lineTo(...v.P(bounds[i + 1], row.floor));
  });
  c.lineTo(...v.P(res.totalDepth, 0));
  c.closePath();
  c.fillStyle = o.primary ? "rgba(120,130,148,.16)" : "rgba(47,111,208,.06)";
  c.fill();
  c.strokeStyle = o.primary ? "#46536a" : color;
  c.lineWidth = o.primary ? 1.8 : 1.6;
  // 只描台阶上线，避免闭合边干扰
  c.beginPath();
  c.moveTo(...v.P(0, 0)); c.lineTo(...v.P(bounds[0], 0));
  L.forEach((row, i) => {
    c.lineTo(...v.P(bounds[i], row.floor));
    c.lineTo(...v.P(bounds[i + 1], row.floor));
  });
  c.stroke();

  // ---- 锁定楼板段：蓝色斜纹 + 锁标记 ----
  if (o.primary) {
    L.forEach((row, i) => {
      if (!row.locked) return;
      const [ax, ay] = v.P(bounds[i], row.floor);
      const [bx, by] = v.P(bounds[i + 1], row.floor - 0.26);
      c.save(); c.beginPath(); c.rect(ax, ay, bx - ax, by - ay); c.clip();
      c.strokeStyle = "rgba(70,120,210,.55)"; c.lineWidth = 1;
      for (let s = ax - (by - ay); s < bx; s += 7) {
        c.beginPath(); c.moveTo(s, by); c.lineTo(s + (by - ay), ay); c.stroke();
      }
      c.restore();
      drawLock(c, (ax + bx) / 2, ay - 7, o.interactive);
      // 踢步高度
      if (i > 0) {
        const rise = row.floor - L[i - 1].floor;
        if (Math.abs(rise) > 0.02) {
          c.fillStyle = "#5a6b82"; c.font = "9px sans-serif";
          c.fillText((rise >= 0 ? "↑" : "↓") + r2(Math.abs(rise)), ax + 2, ay - 16);
        }
      }
    });
  }

  // ---- 视线、遮挡区（净空测在遮挡平面 x_j，即前排头顶平面）----
  if (o.showLines) {
    L.forEach((row) => {
      if (!row.occupied || row.worst < 0) return;
      const j = L[row.worst];
      const sel = row.i === o.selected;
      // 观众实际视线 E_n→V 在遮挡平面 x_j 处的高度，净空 C = yS − headY_j
      const yS = settings.vy + (row.eyeY - settings.vy) * j.x / row.x;
      const col = RISK_COLOR[row.risk];

      if (row.risk === RISK.BAD || row.risk === RISK.BLOCK) {
        // 遮挡楔区：擦前排头顶的视线 E_n→H_j→舞台面
        c.beginPath();
        let p = v.P(0, 0); c.moveTo(p[0], p[1]);
        p = v.P(0, Math.max(0, row.rayY0)); c.lineTo(p[0], p[1]);
        p = v.P(j.x, j.headY); c.lineTo(p[0], p[1]);
        p = v.P(row.x, row.eyeY); c.lineTo(p[0], p[1]);
        p = v.P(row.x, 0); c.lineTo(p[0], p[1]);
        c.closePath();
        c.fillStyle = col; c.globalAlpha = sel ? 0.18 : 0.05 * (o.primary ? 1 : 0);
        c.fill(); c.globalAlpha = o.primary ? 1 : 0.75;
      }

      // 实际视线 E_n → V
      c.strokeStyle = col; c.lineWidth = sel ? 2 : 1;
      c.globalAlpha = sel ? 0.95 : 0.22;
      c.setLineDash(sel ? [] : [5, 4]);
      c.beginPath();
      let p = v.P(row.x, row.eyeY); c.moveTo(p[0], p[1]);
      p = v.P(0, settings.vy); c.lineTo(p[0], p[1]);
      c.stroke();
      // 擦顶视线 E_n→H_j→舞台面（遮挡范围依据）
      c.setLineDash([3, 3]); c.lineWidth = 1;
      c.globalAlpha = sel ? 0.9 : 0;
      c.beginPath();
      p = v.P(row.x, row.eyeY); c.moveTo(p[0], p[1]);
      p = v.P(j.x, j.headY); c.lineTo(p[0], p[1]);
      p = v.P(0, row.rayY0); c.lineTo(p[0], p[1]);
      c.stroke();
      c.setLineDash([]); c.globalAlpha = 1;

      if (sel) {
        // C 值小尺：遮挡平面 x_j 上，前排头顶 ↔ 实际视线
        const [px, topY] = v.P(j.x, j.headY);
        const [, botY] = v.P(j.x, yS);
        c.strokeStyle = "#222"; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(px - 7, topY); c.lineTo(px - 7, botY);
        c.moveTo(px - 10, topY); c.lineTo(px - 4, topY);
        c.moveTo(px - 10, botY); c.lineTo(px - 4, botY); c.stroke();
        c.fillStyle = "#1d2530"; c.font = "bold 11px sans-serif";
        c.fillText("C=" + r3(row.c), px + 6, (topY + botY) / 2 + 4);
        // 遮挡平面引导虚线
        c.strokeStyle = "rgba(40,50,66,.5)"; c.setLineDash([2, 3]); c.lineWidth = 1;
        c.beginPath();
        p = v.P(j.x, j.headY); c.moveTo(p[0], p[1]);
        p = v.P(row.x, row.eyeY); c.lineTo(p[0], p[1]);
        c.stroke(); c.setLineDash([]);
        if (row.blockedH > 0.005) {
          const [zx, zy] = v.P(0, 0);
          c.fillStyle = RISK_COLOR.block; c.font = "bold 10px sans-serif";
          c.fillText("遮挡 " + r2(row.blockedH) + "m", zx + 6, zy - 6);
        }
      }
    });
  }

  // ---- 人物 / 通道 / 轮椅 ----
  if (o.showPeople) {
    L.forEach((row) => {
      const sel = row.i === o.selected;
      if (row.type === "aisle") drawAisle(c, v, bounds[row.i], bounds[row.i + 1], row.floor);
      else if (row.type === "wheel") drawWheelchair(c, v, row, settings, sel);
      else drawSeated(c, v, row, sel);
    });
  } else {
    // 比较模式：仅画眼位点（按风险着色）
    L.forEach((row) => {
      if (!row.occupied) return;
      const [sx, sy] = v.P(row.x, row.eyeY);
      c.fillStyle = row.c === null ? RISK_COLOR.good : RISK_COLOR[row.risk];
      c.beginPath(); c.arc(sx, sy, 3.2, 0, Math.PI * 2); c.fill();
      c.strokeStyle = color; c.lineWidth = 1; c.stroke();
    });
  }

  // 排号
  if (o.showLabels !== false) {
    c.font = "bold 9px sans-serif";
    L.forEach((row) => {
      const [sx, sy] = v.P(row.x, row.floor);
      c.fillStyle = row.type === "aisle" ? "#8a97a8" : "#33415c";
      c.fillText(String(row.i + 1), sx - 3, sy - 4);
    });
  }
}

/* 普通坐姿观众（朝舞台，即画面左侧） */
function drawSeated(c, v, row, sel) {
  const x = row.x, f = row.floor;
  const P = v.P;
  // 椅子
  c.strokeStyle = sel ? "#1d4ed8" : "#5a6b82"; c.lineWidth = sel ? 1.8 : 1.3;
  c.beginPath();
  let p = P(x + 0.02, f + 0.05); c.moveTo(...p);                  // 前腿
  p = P(x + 0.02, f + 0.42); c.lineTo(...p);                    // 座面前沿
  p = P(x + 0.30, f + 0.42); c.lineTo(...p);                    // 座面
  p = P(x + 0.30, f + 0.82); c.lineTo(...p);                    // 靠背
  c.stroke();
  c.beginPath(); p = P(x + 0.27, f + 0.05); c.moveTo(...p);
  c.lineTo(...P(x + 0.27, f + 0.42)); c.stroke();               // 后腿
  // 躯干（含头颈简化）
  c.strokeStyle = "#2b3648"; c.lineWidth = 1.6;
  c.beginPath();
  p = P(x + 0.24, f + 0.46); c.moveTo(...p);
  c.lineTo(...P(x + 0.13, f + 0.86));
  c.lineTo(...P(x - 0.02, row.headY - 0.11));                   // 颈→头
  c.stroke();
  // 头部（头顶对齐 headY）
  const [hx, hy] = P(x - 0.03, row.headY - 0.11);
  const hr = 0.11 * v.sc;
  c.fillStyle = sel ? "rgba(45,105,220,.25)" : "rgba(60,72,92,.18)";
  c.beginPath(); c.arc(hx, hy, hr, 0, Math.PI * 2); c.fill();
  c.strokeStyle = "#2b3648"; c.lineWidth = 1.2; c.stroke();
  // 眼睛（精确落在 eyeY）
  const [ex, ey] = P(x, row.eyeY);
  c.fillStyle = "#c64b3c";
  c.beginPath(); c.arc(ex, ey, 2.4, 0, Math.PI * 2); c.fill();
  // 头顶高度小刻划
  const [, hty] = P(x, row.headY);
  c.strokeStyle = "#2b3648"; c.lineWidth = 1;
  c.beginPath(); c.moveTo(ex - 5, hty); c.lineTo(ex + 5, hty); c.stroke();
}

/* 轮椅位：坐姿人物 + 大轮 + 占位长度 */
function drawWheelchair(c, v, row, s, sel) {
  const x = row.x, f = row.floor, P = v.P;
  // 占位长度括线
  const L = s.wheelLength;
  c.strokeStyle = "#0f766e"; c.setLineDash([4, 3]); c.lineWidth = 1.2;
  c.beginPath();
  let p = P(x - L / 2, f + 0.02); c.moveTo(...p);
  c.lineTo(...P(x - L / 2, f + 0.14));
  c.moveTo(...p); c.lineTo(...P(x + L / 2, f + 0.02));
  p = P(x + L / 2, f + 0.14); c.lineTo(...p);
  c.stroke(); c.setLineDash([]);
  c.fillStyle = "#0f766e"; c.font = "9px sans-serif";
  const [tx, ty] = P(x - L / 2 + 0.02, f + 0.26);
  c.fillText("轮椅位 " + r2(L) + "m", tx, ty);
  // 大轮、小轮
  const [w1x, w1y] = P(x + 0.18, f + 0.30);
  c.strokeStyle = sel ? "#1d4ed8" : "#33415c"; c.lineWidth = 1.6;
  c.beginPath(); c.arc(w1x, w1y, 0.30 * v.sc, 0, Math.PI * 2); c.stroke();
  const [w2x, w2y] = P(x - 0.16, f + 0.13);
  c.beginPath(); c.arc(w2x, w2y, 0.13 * v.sc, 0, Math.PI * 2); c.stroke();
  // 车架与座、靠背
  c.lineWidth = 1.4;
  c.beginPath();
  p = P(x - 0.10, f + 0.42); c.moveTo(...p);
  c.lineTo(...P(x + 0.20, f + 0.42));
  c.lineTo(...P(x + 0.22, f + 0.74));
  c.stroke();
  // 人
  c.strokeStyle = "#2b3648"; c.lineWidth = 1.6;
  c.beginPath();
  p = P(x + 0.12, f + 0.46); c.moveTo(...p);
  c.lineTo(...P(x + 0.02, f + 0.82));
  c.lineTo(...P(x - 0.08, row.headY - 0.11));
  c.stroke();
  const [hx, hy] = P(x - 0.09, row.headY - 0.11);
  c.fillStyle = sel ? "rgba(45,105,220,.25)" : "rgba(60,72,92,.18)";
  c.beginPath(); c.arc(hx, hy, 0.11 * v.sc, 0, Math.PI * 2); c.fill();
  c.strokeStyle = "#2b3648"; c.stroke();
  const [ex, ey] = P(x, row.eyeY);
  c.fillStyle = "#c64b3c";
  c.beginPath(); c.arc(ex, ey, 2.6, 0, Math.PI * 2); c.fill();
}

function drawAisle(c, v, x1, x2, f) {
  const [ax, ay] = v.P(x1, f);
  const [bx, by] = v.P(x2, f - 0.12);
  c.save(); c.beginPath(); c.rect(ax, ay, bx - ax, by - ay); c.clip();
  c.strokeStyle = "rgba(120,132,150,.7)"; c.lineWidth = 1;
  for (let s = ax - 12; s < bx + 12; s += 8) {
    c.beginPath(); c.moveTo(s, by); c.lineTo(s + 12, ay); c.stroke();
  }
  c.restore();
  c.strokeStyle = "#7c8aa0"; c.setLineDash([5, 3]); c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, ay); c.stroke(); c.setLineDash([]);
  c.fillStyle = "#6b788c"; c.font = "10px sans-serif";
  c.fillText("通道（不作遮挡体）", (ax + bx) / 2 - 42, ay - 5);
}

function drawLock(c, cx, cy, interactive) {
  c.save();
  c.fillStyle = interactive ? "#3b74d0" : "#5a6b82";
  c.strokeStyle = "#122038"; c.lineWidth = 0.8;
  // 锁身
  c.fillRect(cx - 5, cy - 2, 10, 8); c.strokeRect(cx - 5, cy - 2, 10, 8);
  // 锁梁
  c.beginPath(); c.arc(cx, cy - 2, 3.4, Math.PI, 0); c.lineWidth = 1.6; c.stroke();
  c.restore();
}

/* 底部尺寸线 + 最高标高 */
function drawRuler(c, v, ds) {
  const { res, settings } = ds;
  const yWorld = Math.min(-0.45, res.minFloor - 0.62);
  const [, ry] = v.P(0, yWorld);
  const [xStart] = v.P(0, 0);
  const [xEnd] = v.P(res.totalDepth, 0);
  c.strokeStyle = "#415066"; c.fillStyle = "#415066"; c.lineWidth = 1.2; c.font = "10px sans-serif";
  c.beginPath(); c.moveTo(xStart, ry); c.lineTo(xEnd, ry);
  c.moveTo(xStart, ry - 4); c.lineTo(xStart, ry + 4);
  c.moveTo(xEnd, ry - 4); c.lineTo(xEnd, ry + 4); c.stroke();
  c.fillText("总进深 " + r2(res.totalDepth) + " m（V→末排后缘）", (xStart + xEnd) / 2 - 78, ry + 16);

  // 首排距离（红色段）
  const [xF] = v.P(settings.firstDistance, 0);
  const [, ry2] = v.P(0, yWorld + 0.28);
  c.strokeStyle = "#c64b3c";
  c.beginPath(); c.moveTo(xStart, ry2); c.lineTo(xF, ry2);
  c.moveTo(xStart, ry2 - 3); c.lineTo(xStart, ry2 + 3);
  c.moveTo(xF, ry2 - 3); c.lineTo(xF, ry2 + 3); c.stroke();
  c.fillStyle = "#c64b3c";
  c.fillText("首排 " + r2(settings.firstDistance), (xStart + xF) / 2 - 24, ry2 - 4);

  // 每排刻度
  res.list.forEach((row) => {
    const [sx] = v.P(row.x, 0);
    c.strokeStyle = "#415066"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(sx, ry - 3); c.lineTo(sx, ry + 3); c.stroke();
    c.fillStyle = row.type === "aisle" ? "#8a97a8" : "#415066";
    c.fillText(String(row.i + 1), sx - 3, ry - 6);
  });

  // 最高标高（右侧竖尺）
  const [mx] = v.P(res.totalDepth + 0.22, 0);
  const [, myTop] = v.P(0, res.maxElev);
  const [, myBot] = v.P(0, 0);
  if (res.maxElev > 0.01) {
    c.strokeStyle = "#2f6fd0"; c.fillStyle = "#2f6fd0"; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(mx, myBot); c.lineTo(mx, myTop);
    c.moveTo(mx - 4, myTop); c.lineTo(mx + 4, myTop);
    c.moveTo(mx - 4, myBot); c.lineTo(mx + 4, myBot); c.stroke();
    c.save(); c.translate(mx + 8, (myTop + myBot) / 2); c.rotate(-Math.PI / 2);
    c.font = "10px sans-serif";
    c.fillText("最高标高 " + r2(res.maxElev) + " m", -58, 0);
    c.restore();
  }
}

/* 可拖控制点 */
function drawHandles(c, v, ds) {
  const { res, settings } = ds;
  // 视点
  const [vx, vy] = v.P(0, settings.vy);
  c.fillStyle = "#e0523c"; c.strokeStyle = "#fff"; c.lineWidth = 1.5;
  c.beginPath(); c.arc(vx, vy, hover && hover.kind === "vp" ? 8 : 6, 0, Math.PI * 2);
  c.fill(); c.stroke();
  c.fillStyle = "#a8412f"; c.font = "bold 11px sans-serif";
  c.fillText("V 视点（可拖）", vx + 9, vy - 8);

  // 各排眼位（锁排/通道仅展示不可垂直拖动，仍给不同样式）
  res.list.forEach((row) => {
    if (!row.occupied) return;
    const [sx, sy] = v.P(row.x, row.eyeY);
    const active = hover && hover.kind === "row" && hover.i === row.i;
    if (row.locked) {
      drawLock(c, sx, sy - 12, true);
      return;
    }
    c.save();
    c.translate(sx, sy);
    c.rotate(Math.PI / 4);
    c.fillStyle = active ? "#e0523c" : (row.type === "wheel" ? "#0f9d8c" : "#2f6fd0");
    c.strokeStyle = "#fff"; c.lineWidth = 1.2;
    const sz = active ? 8 : 6;
    c.fillRect(-sz / 2, -sz / 2, sz, sz); c.strokeRect(-sz / 2, -sz / 2, sz, sz);
    c.restore();
  });
}

/* ============================================================
   拖拽交互
   ============================================================ */

let hover = null;
let drag = null;

function hitTest(px, py) {
  if (!view) return null;
  const ds = primaryDataset();
  const { res, settings } = ds;
  let [sx, sy] = view.P(0, settings.vy);
  if (Math.hypot(px - sx, py - sy) <= 10) return { kind: "vp" };
  for (const row of res.list) {
    // 锁定的固定楼板段不参与拖拽（仍可在排表中改数/解锁）
    if (!row.occupied || row.locked) continue;
    [sx, sy] = view.P(row.x, row.eyeY);
    if (Math.hypot(px - sx, py - sy) <= 11) return { kind: "row", i: row.i };
  }
  return null;
}

function screenToWorld(px, py) {
  const { sc, ox, H, pad, ymin } = view;
  return {
    x: (px - ox) / sc,
    y: ymin + (H - pad - py) / sc,
  };
}

canvas.addEventListener("pointerdown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const h = hitTest(px, py);
  if (!h) return;
  if (h.kind === "row") selected = h.i;
  canvas.setPointerCapture(e.pointerId);
  // 记录按下瞬间的世界坐标与模型基准值，拖动时只按“增量”修改各轴，
  // 避免纵向拖动误改进深、横向 2× 因子导致进深一步撞到边界。
  const w0 = screenToWorld(px, py);
  const baseH = h.kind === "vp"
    ? state.settings.firstDistance          // 视点横向 → 首排距离
    : (h.i === 0 ? state.settings.firstDistance : state.rows[h.i].depth);
  const baseV = h.kind === "vp"
    ? state.settings.vy                     // 视点纵向 → 视点高度
    : state.rows[h.i].elev;
  drag = {
    ...h, moved: false,
    startPX: px, startPY: py,
    w0X: w0.x, w0Y: w0.y,
    depth0: baseH, elev0: baseV,
  };
  canvas.style.cursor = "grabbing";
  refresh();
});

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;

  if (drag && view) {
    const w = screenToWorld(px, py);
    if (Math.abs(px - drag.startPX) + Math.abs(py - drag.startPY) > 2) drag.moved = true;
    const cm = (v) => Math.round(v * 100) / 100;

    if (drag.kind === "vp") {
      // 视点：纵拖改高度、横拖改首排距离，两轴独立增量
      state.settings.vy = cm(clamp(drag.elev0 + (w.y - drag.w0Y), -1, 3));
      state.settings.firstDistance = cm(clamp(drag.depth0 + (w.x - drag.w0X), 0.5, 30));
      syncSettingInputs();
    } else {
      const i = drag.i, row = state.rows[i];
      // 纵向：标高随世界 y 增量连续变化（向上为正）
      row.elev = cm(clamp(drag.elev0 + (w.y - drag.w0Y), -1, 8));
      // 横向：中点模型中 x_i = firstDistance + Σ_{k<i} D_k，
      // 拖动本排中点时其前缘固定，δx_i = δD_i/2，故 δD_i = 2·δx。
      // 首排中点 x_0 = firstDistance（基准），横拖直接改首排距离。
      if (i === 0) {
        state.settings.firstDistance = cm(clamp(drag.depth0 + (w.x - drag.w0X), 0.5, 30));
        syncSettingInputs();
      } else {
        row.depth = cm(clamp(drag.depth0 + 2 * (w.x - drag.w0X), 0.45, 3.0));
      }
      syncRowInputs(i);
    }
    persist();
    refresh();
    return;
  }

  const h = hitTest(px, py);
  hover = h;
  canvas.style.cursor = h ? "grab" : "crosshair";
});

window.addEventListener("pointerup", (e) => {
  if (drag) {
    if (!drag.moved && drag.kind === "row") { selected = drag.i; refresh(); }
    drag = null;
    canvas.style.cursor = hover ? "grab" : "crosshair";
  }
});

/* ============================================================
   DOM：汇总、排表、设置输入
   ============================================================ */

function primaryDataset() {
  const res = compute(state.settings, state.rows);
  return { label: state.name || "当前布置", res, settings: state.settings, rows: state.rows, color: "#33415c" };
}

function compareDatasets() {
  return compareIds
    .map((id) => layoutsCache.find((l) => l.id === id))
    .filter(Boolean)
    .map((l, i) => {
      const s = { ...DEFAULTS.settings, ...(l.data.settings || {}) };
      const rows = (l.data.rows || []).map(normRow);
      return {
        label: l.name, color: COMPARE_COLORS[i % COMPARE_COLORS.length],
        settings: s, rows, res: compute(s, rows),
      };
    });
}

function refresh() {
  const ds = primaryDataset();
  const datasets = [ds, ...compareDatasets()];
  renderSummary(ds.res);
  renderRows(ds.res, false);
  view = drawScene(canvas, datasets, { interactive: true });
  renderLayoutList();
  renderComparePicker();
}

function renderSummary(res) {
  const c = res.counts;
  const cls = (n) => n > 0 ? "" : "good";
  $("summary").innerHTML = `
    <span class="stat"><b>${res.list.length}</b>排（座 ${c.seat} · 轮椅 ${c.wheel} · 通道 ${c.aisle}）</span>
    <span class="stat">总进深 <b>${r2(res.totalDepth)}</b>m</span>
    <span class="stat">最高楼面 <b>${r2(res.maxElev)}</b>m</span>
    <span class="stat">最高眼位 <b>${r2(res.maxEye)}</b>m</span>
    <span class="stat">合格 <b class="good">${c.good}</b></span>
    <span class="stat">偏差 <b class="warn">${c.warn}</b></span>
    <span class="stat">风险 <b class="bad">${c.bad}</b></span>
    <span class="stat">已遮挡 <b class="block">${c.block}</b></span>
    <span class="stat">最差 C <b class="${res.worstC !== null && res.worstC < state.settings.cMin ? "bad" : "good"}">${res.worstC === null ? "—" : r3(res.worstC)}</b>m</span>
  `;
}

const TYPE_LABEL = { seat: "普通座席", wheel: "轮椅位", aisle: "通道" };

function renderRows(res, rebuild) {
  const body = $("rows-body");
  if (rebuild || body.children.length !== state.rows.length) {
    body.innerHTML = "";
    state.rows.forEach((row, i) => body.appendChild(buildRowEl(row, i)));
  }
  // 刷新计算列与选中态
  res.list.forEach((r, i) => {
    const tr = body.children[i];
    if (!tr) return;
    tr.classList.toggle("selected", i === selected);
    tr.classList.toggle("locked-row", !!r.locked);
    tr.querySelector("[data-c]").innerHTML = cCell(r);
    tr.querySelector("[data-block]").textContent =
      r.occupied && r.worst >= 0 ? (r.blockedH > 0.005 ? r2(r.blockedH) + " m" : "0") : "—";
    tr.querySelector("[data-x]").textContent = r2(r.x);
  });
}

function cCell(r) {
  if (r.type === "aisle") return `<span class="badge aisle">通道</span>`;
  if (r.worst < 0) return `— <span class="badge good">首排无遮挡</span>`;
  return `<b>${r3(r.c)}</b> <span class="badge ${r.risk}">${RISK_LABEL[r.risk]}</span>`;
}

function buildRowEl(row, i) {
  const tr = document.createElement("tr");
  tr.dataset.i = i;
  const elevDisabled = row.type === "aisle" ? "disabled" : (row.locked ? "disabled" : "");
  const lockDisabled = row.type === "aisle" ? "disabled" : "";
  tr.innerHTML = `
    <td><span class="idx-badge">${i + 1}</span></td>
    <td>
      <select data-field="type">
        <option value="seat"${row.type === "seat" ? " selected" : ""}>普通座席</option>
        <option value="wheel"${row.type === "wheel" ? " selected" : ""}>轮椅位</option>
        <option value="aisle"${row.type === "aisle" ? " selected" : ""}>通道</option>
      </select>
    </td>
    <td><input type="number" class="num-input" step="0.01" min="0.45" max="3"
        data-field="depth" value="${r2(row.depth)}"></td>
    <td><input type="number" class="num-input" step="0.01" data-field="elev"
        ${elevDisabled} value="${r2(row.elev)}"></td>
    <td data-x></td>
    <td data-c></td>
    <td data-block></td>
    <td style="text-align:center">
      <input type="checkbox" data-field="locked" ${row.locked ? "checked" : ""} ${lockDisabled}>
    </td>
    <td><button type="button" class="del-btn" title="删除本排">✕</button></td>
  `;

  tr.addEventListener("click", (e) => {
    if (e.target.closest("input,select,button")) return;
    selected = i; refresh();
  });

  tr.querySelector('[data-field="type"]').addEventListener("change", (e) => {
    state.rows[i].type = e.target.value;
    if (state.rows[i].type === "aisle") state.rows[i].locked = false;
    persist();
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
  tr.querySelector('[data-field="depth"]').addEventListener("input", (e) => {
    state.rows[i].depth = clamp(num(e.target, state.rows[i].depth), 0.45, 3);
    persist(); refresh();
  });
  tr.querySelector('[data-field="elev"]').addEventListener("input", (e) => {
    if (state.rows[i].locked || state.rows[i].type === "aisle") return;
    state.rows[i].elev = clamp(num(e.target, state.rows[i].elev), -1, 8);
    persist(); refresh();
  });
  tr.querySelector('[data-field="locked"]').addEventListener("change", (e) => {
    state.rows[i].locked = e.target.checked && state.rows[i].type !== "aisle";
    persist();
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
  tr.querySelector(".del-btn").addEventListener("click", () => {
    state.rows.splice(i, 1);
    if (selected >= state.rows.length) selected = state.rows.length - 1;
    persist();
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
  return tr;
}

function syncRowInputs(i) {
  const tr = $("rows-body").children[i];
  if (!tr) return;
  tr.querySelector('[data-field="depth"]').value = r2(state.rows[i].depth);
  const el = tr.querySelector('[data-field="elev"]');
  if (el && !state.rows[i].locked) el.value = r2(state.rows[i].elev);
}

function syncSettingInputs() {
  document.querySelectorAll("[data-bind]").forEach((el) => {
    const k = el.dataset.bind;
    if (state.settings[k] !== undefined) el.value = r2(state.settings[k]);
  });
}

/* 设置栏绑定 */
function bindSettings() {
  document.querySelectorAll("[data-bind]").forEach((el) => {
    el.addEventListener("input", () => {
      const k = el.dataset.bind;
      state.settings[k] = num(el, state.settings[k]);
      persist(); refresh();
    });
  });

  $("btn-apply-rowcount").addEventListener("click", () => {
    const n = clamp(parseInt($("set-rowcount").value, 10) || state.rows.length, 1, 200);
    while (state.rows.length < n) {
      const last = state.rows[state.rows.length - 1];
      state.rows.push(normRow({ type: "seat", depth: last ? last.depth : 0.9,
        elev: last ? last.elev : 0, locked: false }));
    }
    if (state.rows.length > n) state.rows.length = n;
    persist();
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
  $("btn-add-row").addEventListener("click", () => {
    const last = state.rows[state.rows.length - 1];
    state.rows.push(normRow({ type: "seat", depth: last ? last.depth : 0.9,
      elev: last ? last.elev : 0, locked: false }));
    persist();
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
  $("btn-autogradient").addEventListener("click", () => {
    autoGradient();
    persist();
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
  $("btn-unlock-all").addEventListener("click", () => {
    state.rows.forEach((r) => { r.locked = false; });
    persist();
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
  $("btn-reset").addEventListener("click", () => {
    if (!confirm("恢复为内置示例数据？当前未保存到服务器的修改将丢失。")) return;
    state = freshState();
    savedId = null; selected = -1;
    persist();
    syncSettingInputs();
    $("layout-name").value = ""; $("layout-note").value = "";
    renderRows(compute(state.settings, state.rows), true);
    refresh();
  });
}

/* ============================================================
   服务器布置存取（fetch + JSON）
   ============================================================ */

async function api(path, options) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || ("HTTP " + resp.status));
  return data;
}

async function refreshLayouts() {
  const data = await api("/api/layouts");
  layoutsCache = data.layouts || [];
  compareIds = compareIds.filter((id) => layoutsCache.some((l) => l.id === id));
  renderLayoutList();
  renderComparePicker();
  refresh();
}

function renderLayoutList() {
  const box = $("layout-list");
  if (!layoutsCache.length) {
    box.innerHTML = `<p class="hint">尚无保存布置。命名后点击“保存到服务器”。</p>`;
    return;
  }
  box.innerHTML = "";
  layoutsCache.forEach((l) => {
    const div = document.createElement("div");
    div.className = "layout-item" + (l.id === savedId ? " loaded" : "");
    const nRows = (l.data.rows || []).length;
    div.innerHTML = `
      <div class="li-name"><span>📁 ${esc(l.name)}</span></div>
      <div class="li-meta">${nRows} 排 · 更新于 ${fmtTime(l.updated_at)}</div>
      <div class="li-actions">
        <button type="button" class="secondary" data-act="load">载入</button>
        <button type="button" class="secondary" data-act="del">删除</button>
      </div>`;
    div.querySelector('[data-act="load"]').addEventListener("click", () => loadLayout(l.id));
    div.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`确定删除布置“${l.name}”？`)) return;
      await api("/api/layouts/" + l.id, { method: "DELETE" });
      if (savedId === l.id) savedId = null;
      await refreshLayouts();
    });
    box.appendChild(div);
  });
}

function applyLayoutData(l) {
  state = {
    name: l.name,
    note: l.note || "",
    settings: { ...DEFAULTS.settings, ...(l.data.settings || {}) },
    rows: (l.data.rows || []).map(normRow),
  };
  selected = -1;
  savedId = l.id;
  persist();
  syncSettingInputs();
  $("layout-name").value = l.name;
  $("layout-note").value = l.note || "";
  $("set-rowcount").value = state.rows.length;
  renderRows(compute(state.settings, state.rows), true);
  refresh();
}

async function loadLayout(id) {
  const data = await api("/api/layouts/" + id);
  applyLayoutData(data.layout);
}

function bindSave() {
  $("layout-name").addEventListener("input", (e) => { state.name = e.target.value; });
  $("layout-note").addEventListener("input", (e) => { state.note = e.target.value; });

  $("btn-save").addEventListener("click", async () => {
    const name = $("layout-name").value.trim();
    if (!name) { flash("请先填写布置名称"); return; }
    state.name = name; state.note = $("layout-note").value;
    const payload = { name, note: state.note, data: { settings: state.settings, rows: state.rows } };
    try {
      const resp = savedId
        ? await api("/api/layouts/" + savedId, { method: "PUT", body: JSON.stringify(payload) })
        : await api("/api/layouts", { method: "POST", body: JSON.stringify(payload) });
      savedId = resp.layout.id;
      flash("已保存（id=" + savedId + "）", true);
      await refreshLayouts();
    } catch (e) {
      flash("保存失败：" + e.message);
    }
  });
}

let flashTimer = null;
function flash(msg, ok) {
  const el = $("save-hint");
  el.textContent = msg;
  el.style.color = ok ? "var(--good)" : "var(--bad)";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ""; }, 3000);
}

/* ============================================================
   叠加比较
   ============================================================ */

function renderComparePicker() {
  const box = $("compare-picker");
  if (!layoutsCache.length) { box.innerHTML = `<p class="hint">保存布置后可勾选比较。</p>`; return; }
  box.innerHTML = "";
  layoutsCache.forEach((l, idx) => {
    const ci = compareIds.indexOf(l.id);
    const color = ci >= 0 ? COMPARE_COLORS[ci] : "#5a6b82";
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" ${ci >= 0 ? "checked" : ""}>
      <span class="swatch" style="background:${color}"></span>${esc(l.name)}（${(l.data.rows || []).length} 排）`;
    lab.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) {
        if (compareIds.length >= 4) { e.target.checked = false; alert("最多同时比较 4 套布置"); return; }
        compareIds.push(l.id);
      } else {
        compareIds = compareIds.filter((x) => x !== l.id);
      }
      renderComparePicker();
      refresh();
    });
    box.appendChild(lab);
  });
}

$("btn-clear-compare").addEventListener("click", () => {
  compareIds = [];
  renderComparePicker();
  refresh();
});

$("btn-compare").addEventListener("click", () => {
  if (compareIds.length < 1) { alert("请先在右栏勾选至少 1 套已保存布置（与当前布置叠加）"); return; }
  $("compare-modal").classList.remove("hidden");
  drawCompare();
});
$("btn-close-compare").addEventListener("click", () => $("compare-modal").classList.add("hidden"));

function drawCompare() {
  const cc = $("compare-canvas");
  const ds = [primaryDataset(), ...compareDatasets()];
  ds[0].label = "当前：" + (state.name || "未命名");
  drawScene(cc, ds, {
    interactive: false, noPeople: compareIds.length > 0, noLines: false,
    compareAlpha: 0.85,
  });
  renderCompareTable(ds);
}

function renderCompareTable(ds) {
  const table = $("compare-table");
  const maxN = Math.max(...ds.map((d) => d.res.list.length));
  const head = table.querySelector("thead");
  const body = table.querySelector("tbody");
  head.innerHTML = "<tr><th>排</th><th>类型</th>" +
    ds.map((d, i) => `<th colspan="3" style="color:${d.color}">${esc(d.label)}</th>`).join("") + "</tr>" +
    "<tr><th></th><th></th>" + ds.map(() => "<th>标高</th><th>C 值</th><th>判定</th>").join("") + "</tr>";
  body.innerHTML = "";
  for (let i = 0; i < maxN; i++) {
    const tr = document.createElement("tr");
    const t0 = ds[0].res.list[i];
    tr.innerHTML = `<td>${i + 1}</td><td>${t0 ? TYPE_LABEL[t0.type] : "—"}</td>` +
      ds.map((d) => {
        const r = d.res.list[i];
        if (!r) return "<td colspan='3' class='hint'>无此排</td>";
        if (!r.occupied) return `<td>${r2(r.floor)}</td><td>—</td><td><span class="badge aisle">通道</span></td>`;
        const c0 = t0 && t0.occupied && t0.c !== null && r.c !== null
          ? `<br><span class="hint">Δ ${r.c - t0.c >= 0 ? "+" : ""}${r3(r.c - t0.c)}</span>` : "";
        return `<td>${r2(r.floor)}</td>
          <td style="color:${RISK_COLOR[r.risk]};font-weight:700">${r.c === null ? "—" : r3(r.c)}${c0}</td>
          <td><span class="badge ${r.risk}">${r.worst < 0 ? "首排" : RISK_LABEL[r.risk]}</span></td>`;
      }).join("");
    body.appendChild(tr);
  }
  // 汇总行
  const tr = document.createElement("tr");
  tr.innerHTML = "<td colspan='2'><b>总进深 / 最高标高</b></td>" +
    ds.map((d) => `<td colspan="3">${r2(d.res.totalDepth)} m / ${r2(d.res.maxElev)} m
      <br><span class="hint">风险 ${d.res.counts.bad + d.res.counts.block} 排 · 偏差 ${d.res.counts.warn} 排</span></td>`).join("");
  body.appendChild(tr);
}

/* ============================================================
   打印报告
   ============================================================ */

function buildReportDoc({ title, body }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>
  body{font-family:"SimSun","Songti SC",serif;color:#111;padding:26px;margin:0}
  h1{font-size:21px;text-align:center;margin:0 0 4px}
  .sub{text-align:center;color:#444;font-size:12px;margin-bottom:16px}
  h2{font-size:15px;border-left:4px solid #333;padding-left:8px;margin:20px 0 8px}
  table{width:100%;border-collapse:collapse;font-size:11px;margin:8px 0}
  th,td{border:1px solid #888;padding:4px 6px;text-align:center}
  th{background:#eee}
  .r-good{color:#0a7a4d;font-weight:700}.r-warn{color:#b07b00;font-weight:700}
  .r-bad{color:#c4452c;font-weight:700}.r-block{color:#a01010;font-weight:700}
  img.diagram{width:100%;border:1px solid #999;margin:8px 0}
  ul{font-size:12px;line-height:1.85;padding-left:22px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 28px}
  .note{font-size:12px;border:1px solid #999;padding:8px 12px;background:#fafafa}
  .foot{margin-top:24px;font-size:10px;color:#666;text-align:center}
  @media print{.noprint{display:none}}
</style></head><body>
<div class="noprint" style="text-align:right;margin-bottom:8px">
  <button onclick="window.print()" style="padding:6px 18px;font-size:14px">打印 / 另存为 PDF</button>
</div>
${body}
<div class="foot">观众席视线校核台 · 生成时间 ${fmtTime(Date.now() / 1000)} · 依据 JGJ 57-2016《剧场设计规范》视线升起（C 值）法几何模型</div>
</body></html>`;
}

function calcBasisLis(s) {
  return `
    <li><b>坐标系</b>：以舞台视点 V 为原点，水平向观众厅为 x 轴（m），舞台面为 y=0，向上为正。
        首排眼位 x<sub>1</sub> = 首排距离 = ${r2(s.firstDistance)} m；其后 x<sub>n</sub> = x<sub>n-1</sub> + D<sub>n</sub>，D<sub>n</sub> 为各排进深。</li>
    <li><b>眼睛与头顶</b>：第 n 排眼位 E<sub>n</sub>=(x<sub>n</sub>, 楼面标高 + 坐姿眼高)，
        眼高 ${r2(s.eyeHeight)} m、头顶高 ${r2(s.headHeight)} m；轮椅位可另设眼高 ${r2(s.wheelEye)} m、占位长度 ${r2(s.wheelLength)} m。</li>
    <li><b>C 值校核（遮挡平面净空口径）</b>：第 n 排观众的视线为 E<sub>n</sub>(x<sub>n</sub>, 眼位高)→V。
        对其先前每一有效排 j（通道不计），该视线在<b>遮挡平面 x<sub>j</sub>（前排头顶所在平面）</b>处的高度
        y<sub>S</sub> = y<sub>V</sub> + (E<sub>n</sub> − y<sub>V</sub>)·x<sub>j</sub>/x<sub>n</sub>，
        头顶平面净空 C<sub>n,j</sub> = y<sub>S</sub> − H<sub>j</sub>；取全部 j 中最小值为该排 C 值（最不利遮挡排）。
        注意该值测在遮挡平面，不等于视线在本排眼位平面处的余量。</li>
    <li><b>判定阈值</b>：C ≥ ${r2(s.cGood)} m 判定合格；${r2(s.cMin)} ≤ C &lt; ${r2(s.cGood)} m 为偏差（可见但净空偏小）；
        0 ≤ C &lt; ${r2(s.cMin)} m 为遮挡风险；C &lt; 0 时视点被前座完全遮挡。设计常用 C=0.12 m，困难条件下可取 0.06 m（JGJ 57-2016）。</li>
    <li><b>遮挡范围</b>：将 E<sub>n</sub> 与最不利排头顶的连线延长至舞台面 x=0，交点高度 y<sub>0</sub> 即舞台面上被遮挡的高度（0～y<sub>0</sub> 不可见）。</li>
    <li><b>自动起坡</b>：自首个有效排起按 C≥${r2(s.cGood)} m 逐排递推所需眼位，反求各排楼面标高；
        已锁定的固定楼板段保持原标高并作为后续排的切线基准；横向通道不作遮挡体，其楼面按相邻排线性插值。</li>
    <li><b>构造假设</b>：各排眼位位于该排进深中点所在视线平面；头眼高差对普通席与轮椅席取相同值；
        校核为纵向中轴剖面，未含横向偏座（越座视线）与墙体栏板遮挡。</li>`;
}

function settingsTable(s) {
  const rows2 = [
    ["视点高度 yV (m)", r2(s.vy)], ["首排距离 (m)", r2(s.firstDistance)],
    ["坐姿眼高 (m)", r2(s.eyeHeight)], ["坐姿头顶高度 (m)", r2(s.headHeight)],
    ["C 值目标 (m)", r2(s.cGood)], ["C 值最低限 (m)", r2(s.cMin)],
    ["轮椅眼高 (m)", r2(s.wheelEye)], ["轮椅占位长度 (m)", r2(s.wheelLength)],
  ];
  return "<table>" + rows2.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("") + "</table>";
}

function rowsResultTable(res) {
  const head = `<tr><th>排</th><th>类型</th><th>进深 D(m)</th><th>楼面标高(m)</th>
    <th>水平距 V(m)</th><th>眼位标高(m)</th><th>C 值·遮挡平面净空(m)</th><th>判定</th>
    <th>遮挡舞台高(m)</th><th>锁定</th></tr>`;
  const body = res.list.map((r) => {
    const judge = r.type === "aisle"
      ? `<td>—</td><td>通道</td>`
      : r.worst < 0
        ? `<td>—</td><td class="r-good">首排无遮挡</td>`
        : `<td class="r-${r.risk}">${r3(r.c)}</td><td class="r-${r.risk}">${RISK_LABEL[r.risk]}</td>`;
    return `<tr>
      <td>${r.i + 1}</td><td>${TYPE_LABEL[r.type]}${r.type === "wheel" ? "（占位 " + r2(state.settings.wheelLength) + "m）" : ""}</td>
      <td>${r2(r.depth)}</td><td>${r2(r.floor)}</td><td>${r2(r.x)}</td>
      <td>${r.occupied ? r2(r.eyeY) : "—"}</td>
      ${judge}
      <td>${r.occupied && r.worst >= 0 ? (r.blockedH > 0.005 ? r2(r.blockedH) : "0") : "—"}</td>
      <td>${r.locked ? "🔒 锁定" : ""}</td></tr>`;
  }).join("");
  return "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
}

$("btn-report").addEventListener("click", () => {
  const res = compute(state.settings, state.rows);
  // 用离屏高分辨率画布生成报告插图
  const off = document.createElement("canvas");
  off.style.width = "100%";
  off.width = 1600; off.height = 900;
  const ds = [{ ...primaryDataset(), color: "#33415c" }];
  // 离屏绘制：clientWidth/Height 兜底
  const fakeClient = { width: 1600, height: 900 };
  const c = off.getContext("2d");
  c.fillStyle = "#fbfbf8"; c.fillRect(0, 0, 1600, 900);
  drawSceneFixed(off, ds, 1600, 900);
  const dataUrl = off.toDataURL("image/png");

  const c2 = res.counts;
  const body = `
    <h1>观众席视线校核报告</h1>
    <div class="sub">${esc(state.name || "未命名布置")}　|　${fmtTime(Date.now() / 1000)}
      ${state.note ? "<br>" + esc(state.note) : ""}</div>

    <h2>一、剖面示意图</h2>
    <img class="diagram" src="${dataUrl}">

    <h2>二、输入参数</h2>
    <div class="grid2">${settingsTable(state.settings)}
      <table>
        <tr><th>总排数</th><td>${res.list.length}（普通 ${c2.seat} · 轮椅 ${c2.wheel} · 通道 ${c2.aisle}）</td></tr>
        <tr><th>总进深（V→末排后缘）</th><td>${r2(res.totalDepth)} m</td></tr>
        <tr><th>最高楼面标高</th><td>${r2(res.maxElev)} m</td></tr>
        <tr><th>最高眼位标高</th><td>${r2(res.maxEye)} m</td></tr>
        <tr><th>合格 / 偏差 / 风险 / 遮挡</th><td>${c2.good} / ${c2.warn} / ${c2.bad} / ${c2.block} 排</td></tr>
        <tr><th>全厅最差 C 值</th><td class="${res.worstC !== null && res.worstC < state.settings.cMin ? "r-bad" : "r-good"}">${res.worstC === null ? "—" : r3(res.worstC)} m</td></tr>
      </table>
    </div>

    <h2>三、逐排计算结果</h2>
    ${rowsResultTable(res)}

    <h2>四、计算依据与说明</h2>
    <ul>${calcBasisLis(state.settings)}</ul>
    <div class="note">风险处置建议：对“偏差”排可优先微调后一排标高或加大排距；“遮挡风险/已遮挡”排应抬升本排楼面、
      增大错排或调整首排距离；锁定段为现状不可改楼板时，应在其后按本报告公式重新起坡并复校全部后排。</div>
  `;
  const win = window.open("", "_blank");
  if (!win) { alert("浏览器拦截了报告窗口，请允许弹出窗口"); return; }
  win.document.open();
  win.document.write(buildReportDoc({ title: "视线校核报告 - " + (state.name || ""), body }));
  win.document.close();
});

/* 报告 / 比较打印共用：固定尺寸绘制 */
function drawSceneFixed(canvasEl, datasets, W, H) {
  drawScene(canvasEl, datasets, { interactive: false, dpr: 1, width: W, height: H });
}

$("btn-compare-print").addEventListener("click", () => {
  const ds = [primaryDataset(), ...compareDatasets()];
  ds[0].label = "当前：" + (state.name || "未命名");
  const off = document.createElement("canvas");
  off.width = 1700; off.height = 820;
  drawSceneFixed(off, ds, 1700, 820);

  // 比较表 HTML 化
  const maxN = Math.max(...ds.map((d) => d.res.list.length));
  const tableHead = "<tr><th>排</th>" +
    ds.map((d, i) => `<th style="color:${d.color}">${esc(d.label)} 标高</th><th style="color:${d.color}">C</th><th style="color:${d.color}">判定</th>`).join("") + "</tr>";
  let rowsHtml = "";
  for (let i = 0; i < maxN; i++) {
    rowsHtml += "<tr><td>" + (i + 1) + "</td>" + ds.map((d) => {
      const r = d.res.list[i];
      if (!r) return "<td colspan='3'>—</td>";
      if (!r.occupied) return `<td>${r2(r.floor)}</td><td>—</td><td>通道</td>`;
      return `<td>${r2(r.floor)}</td><td class="r-${r.risk}">${r.c === null ? "—" : r3(r.c)}</td>
        <td class="r-${r.risk}">${r.worst < 0 ? "首排" : RISK_LABEL[r.risk]}</td>`;
    }).join("") + "</tr>";
  }

  const body = `
    <h1>多方案视线叠加比较报告</h1>
    <div class="sub">${ds.map((d, i) => `<span style="color:${d.color}">■ ${esc(d.label)}</span>　`).join("")}</div>
    <h2>一、剖面对比</h2>
    <img class="diagram" src="${off.toDataURL("image/png")}">
    <h2>二、总体指标</h2>
    <table><tr><th>方案</th><th>总进深(m)</th><th>最高标高(m)</th><th>合格</th><th>偏差</th><th>风险</th><th>遮挡</th><th>最差 C(m)</th></tr>
      ${ds.map((d) => `<tr><td style="color:${d.color}">${esc(d.label)}</td>
        <td>${r2(d.res.totalDepth)}</td><td>${r2(d.res.maxElev)}</td>
        <td class="r-good">${d.res.counts.good}</td><td class="r-warn">${d.res.counts.warn}</td>
        <td class="r-bad">${d.res.counts.bad}</td><td class="r-block">${d.res.counts.block}</td>
        <td>${d.res.worstC === null ? "—" : r3(d.res.worstC)}</td></tr>`).join("")}
    </table>
    <h2>三、逐排风险差异</h2>
    <table><thead>${tableHead}</thead><tbody>${rowsHtml}</tbody></table>
    <h2>四、计算依据</h2><ul>${calcBasisLis(state.settings)}</ul>`;
  const win = window.open("", "_blank");
  if (!win) { alert("浏览器拦截了报告窗口，请允许弹出窗口"); return; }
  win.document.open();
  win.document.write(buildReportDoc({ title: "多方案视线比较", body }));
  win.document.close();
});

/* ============================================================
   启动
   ============================================================ */


// 数值验证测试主体（与 app.js 源码拼接后运行）
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}

// ---------- 用例 1：自动起坡后每排在“遮挡平面”净空恰好 ≈ cGood ----------
const s = { ...DEFAULTS.settings };
let rows = [];
for (let i = 0; i < 8; i++) rows.push({ type: "seat", depth: 0.9, elev: 0, locked: false });
state = { settings: s, rows };
autoGradient();
let res = compute(s, rows);
console.log("用例1 自动起坡逐排标高：", rows.map(r => r.elev.toFixed(3)).join(", "));
res.list.forEach((r, i) => {
  if (i === 0) return;
  check(`第${i + 1}排 遮挡平面 C≈0.12`, r.c >= 0.12 - 1e-9 && r.c <= 0.1211, { c: r.c });
  check(`第${i + 1}排 合格`, r.risk === "good", { risk: r.risk });
});
check("起坡递增", rows[7].elev > rows[1].elev);

// ---------- 用例 2：平地楼座，后排应报遮挡 ----------
const flat = Array.from({ length: 6 }, () => ({ type: "seat", depth: 0.85, elev: 0, locked: false }));
res = compute(s, flat);
console.log("用例2 平地 C 值：", res.list.map(r => r.c === null ? "首" : r.c.toFixed(3)).join(", "));
check("第2排即 C<0.12", res.list[1].c < s.cGood, { c: res.list[1].c });
check("存在 bad/block 标记", res.counts.bad + res.counts.block > 0, res.counts);
check("遮挡高度 >0（被遮挡排）", res.list.some(r => r.blockedH > 0));
res.list.forEach(r => check("遮挡高非负且有限", Number.isFinite(r.blockedH) && r.blockedH >= 0, { b: r.blockedH }));

// ---------- 用例 3：首排无 worst ----------
res = compute(s, [{ type: "seat", depth: 0.9, elev: 0, locked: false }]);
check("单排：无遮挡", res.list[0].worst === -1 && res.list[0].risk === "good");

// ---------- 用例 4：通道不参与遮挡 ----------
const withAisle = [
  { type: "seat", depth: 0.9, elev: 0 },
  { type: "aisle", depth: 1.2, elev: 0 },
  { type: "seat", depth: 0.9, elev: 0.30 },
];
res = compute(s, withAisle);
check("通道 risk=aisle、无 C", res.list[1].risk === "aisle" && res.list[1].c === null);
check("第3排 worst=第1排（跳过通道）", res.list[2].worst === 0, { worst: res.list[2].worst });
check("通道楼面按相邻眼位间距离插值(0.15)", Math.abs(res.list[1].floor - 0.15) < 1e-9, { f: res.list[1].floor });

// ---------- 用例 5：轮椅位另设眼高 ----------
const s2 = { ...s, wheelEye: 1.30 };
const withWheel = [
  { type: "seat", depth: 0.9, elev: 0 },
  { type: "wheel", depth: 0.9, elev: 0 },
];
res = compute(s2, withWheel);
check("轮椅眼位=楼面+wheelEye", Math.abs(res.list[1].eyeY - 1.30) < 1e-9, { e: res.list[1].eyeY });
check("轮椅头顶沿用头眼高差", Math.abs(res.list[1].headY - (1.30 + (s.headHeight - s.eyeHeight))) < 1e-9);

// ---------- 用例 6：锁定排不被自动起坡修改，且其后排 C 按遮挡平面口径达标 ----------
const locked = [
  { type: "seat", depth: 0.9, elev: 0, locked: true },
  { type: "seat", depth: 0.9, elev: 0.05, locked: true },
  { type: "seat", depth: 0.9, elev: 0.05, locked: false },
];
state = { settings: s, rows: locked };
autoGradient();
check("锁定两排标高不变", locked[0].elev === 0 && locked[1].elev === 0.05);
check("第三排被抬高", locked[2].elev > 0.05, { e: locked[2].elev });
res = compute(s, locked);
check("第三排 遮挡平面 C≥0.12", res.list[2].c >= 0.12 - 1e-9, { c: res.list[2].c });

// ---------- 用例 7：水平位置与总进深（中点占地模型）----------
const pos = [
  { type: "seat", depth: 0.9, elev: 0 },
  { type: "seat", depth: 0.9, elev: 0 },
];
res = compute({ ...s, firstDistance: 4.5 }, pos);
check("首排眼位 x=4.5", Math.abs(res.list[0].x - 4.5) < 1e-9, { x: res.list[0].x });
check("次排眼位 x=5.4", Math.abs(res.list[1].x - 5.4) < 1e-9, { x: res.list[1].x });
check("首排前缘=4.05", Math.abs(res.dxs[0] - 4.05) < 1e-9);
check("总进深=前缘+占地=5.85", Math.abs(res.totalDepth - 5.85) < 1e-9, { t: res.totalDepth });

// 通道宽度语义
const aislePos = [
  { type: "seat", depth: 0.9, elev: 0 },
  { type: "aisle", depth: 1.2, elev: 0 },
];
res = compute({ ...s, firstDistance: 4.5 }, aislePos);
check("通道占地 1.2m：前缘 4.95 / 中心 5.55 / 后缘 6.15",
  Math.abs(res.list[1].x - 5.55) < 1e-9 && Math.abs(res.dxs[1] - 4.95) < 1e-9,
  { x: res.list[1].x, front: res.dxs[1] });

// ---------- 用例 8：平地反例（旧口径报 C=-0.21 的情形用遮挡平面口径复核）----------
// V=(0,1.0)，第1排 x=5 眼1.15/头1.30；第2排 x=6 平地眼1.15。
// 遮挡平面净空 C = (1+0.15·5/6) − 1.30 = 1.125−1.30 = −0.175
const s8 = { ...s, vy: 1.0, firstDistance: 5.0 };
res = compute(s8, [
  { type: "seat", depth: 1.0, elev: 0 },
  { type: "seat", depth: 1.0, elev: 0 },
]);
check("手算 遮挡平面 C=-0.175", Math.abs(res.list[1].c - (-0.175)) < 1e-9, { c: res.list[1].c });
check("判定为已遮挡", res.list[1].risk === "block");
// 射线 E2(6,1.15)→H1(5,1.30) 斜率 -0.15，x=0 时 y=2.05
check("遮挡范围 y0=2.05", Math.abs(res.list[1].rayY0 - 2.05) < 1e-9, { y: res.list[1].rayY0 });
check("blockedH=max(0,y0)=2.05", Math.abs(res.list[1].blockedH - 2.05) < 1e-9, { b: res.list[1].blockedH });

// ---------- 用例 9（回归反例）：V=(0,1.0)、x1=5、x2=6 ----------
// 旧程序按“后排眼位平面”抬高后排使 C_old=0.121，却把实际遮挡平面净空
// 0.100833 m 误标为合格。统一口径后：净空必须 = 0.100833 < 0.12，判“偏差”。
{
  const s9 = { ...s, vy: 1.0, firstDistance: 5.0, cGood: 0.12, cMin: 0.06 };
  // 后排眼位 1.481（旧口径下 C_old = 1.481 − [1+0.3·6/5=1.36] = 0.121）
  const eye2 = 1.481;
  const rows9 = [
    { type: "seat", depth: 1.0, elev: 0, locked: false },            // x=5，头 1.30
    { type: "seat", depth: 1.0, elev: +(eye2 - s9.eyeHeight).toFixed(3), locked: false }, // x=6
  ];
  res = compute(s9, rows9);
  const r2row = res.list[1];
  console.log("用例9 遮挡平面 C =", r2row.c);
  check("遮挡平面净空 = 0.100833 m", Math.abs(r2row.c - 0.100833) < 1e-6, { c: r2row.c });
  check("C 不等于旧口径 0.121", Math.abs(r2row.c - 0.121) > 0.005, { c: r2row.c });
  check("净空 0.100833 < 0.12 不得判合格", r2row.risk !== "good", { risk: r2row.risk });
  check("应判为偏差（0.06 ≤ C < 0.12）", r2row.risk === "warn", { risk: r2row.risk });

  // 自动起坡应把后排继续抬高，直到遮挡平面净空 ≥ 0.12
  state = { settings: s9, rows: rows9.map(r => ({ ...r })) };
  autoGradient();
  const resAfter = compute(s9, state.rows);
  check("自动起坡后遮挡平面 C ≥ 0.12", resAfter.list[1].c >= 0.12 - 1e-9, { c: resAfter.list[1].c });
  check("自动起坡后判合格", resAfter.list[1].risk === "good", { risk: resAfter.list[1].risk });
  // 所需后排眼位 = 1 + (0.42)·6/5 = 1.504
  check("所需眼位≈1.504（高于旧口径的1.481）",
    Math.abs(resAfter.list[1].eyeY - 1.504) < 2e-3, { eye: resAfter.list[1].eyeY });
}

console.log("\n结果：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
