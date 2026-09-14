
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

/* ---------------- 平面布置：默认值 ---------------- */

const PLAN_DEFAULTS = {
  seatW: 0.52,   // 座宽（m）
  headW: 0.20,   // 头部遮挡宽度（m）
  rowCfg: { seats: 12, gap: 0.04, stagger: 0, aisleL: 1.10, aisleR: 1.10 },
};

function samplePlanTargets() {
  return [
    { id: 1, name: "台口中线", x: 0 },
    { id: 2, name: "台口左侧", x: -3.2 },
    { id: 3, name: "台口右侧", x: 3.2 },
  ];
}

function freshPlan() {
  return {
    seatW: PLAN_DEFAULTS.seatW,
    headW: PLAN_DEFAULTS.headW,
    activeTarget: 1,
    targets: samplePlanTargets(),
    rows: {},            // 排号(0 基) → { seats, gap, stagger, aisleL, aisleR }
  };
}

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
let selectedSeat = -1;        // 当前选中座位（排内座号，-1 = 整排）
let savedId = null;           // 已载入/已保存的服务器布置 id
let layoutsCache = [];        // 服务器布置列表
let compareIds = [];          // 叠加比较的布置 id
let view = null;              // 最近一次绘制的坐标变换（供命中测试）
let planView = null;          // 平面图坐标变换
let planHeat = true;          // 平面遮挡热力显示开关
let planCache = null;         // 每次 refresh 内的平面校核缓存
let planRankingCache = null;  // 各目标点汇总缓存

function freshState() {
  return {
    name: "",
    note: "",
    settings: { ...DEFAULTS.settings },
    rows: sampleRows(),
    plan: freshPlan(),
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
          plan: normPlan(obj.plan),
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

/* ---------------- 平面布置：规范化 ---------------- */

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
}
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
}

function normTarget(t) {
  if (!t || typeof t !== "object") return null;
  const id = Math.round(Number(t.id));
  if (!Number.isFinite(id)) return null;
  return {
    id,
    name: String(t.name == null ? "" : t.name).slice(0, 20) || ("目标点 " + id),
    x: clampNum(t.x, -25, 25, 0),
  };
}

function normPlanRowCfg(o) {
  o = o && typeof o === "object" ? o : {};
  return {
    seats: clampInt(o.seats, 2, 60, PLAN_DEFAULTS.rowCfg.seats),
    gap: clampNum(o.gap, 0, 0.3, PLAN_DEFAULTS.rowCfg.gap),
    stagger: clampNum(o.stagger, -1, 1, 0),
    aisleL: clampNum(o.aisleL, 0, 3, PLAN_DEFAULTS.rowCfg.aisleL),
    aisleR: clampNum(o.aisleR, 0, 3, PLAN_DEFAULTS.rowCfg.aisleR),
  };
}

function normPlan(p) {
  p = p && typeof p === "object" ? p : {};
  const targets = (Array.isArray(p.targets) ? p.targets : []).map(normTarget).filter(Boolean);
  if (!targets.length) targets.push(...samplePlanTargets());
  const rows = {};
  if (p.rows && typeof p.rows === "object") {
    for (const [k, v] of Object.entries(p.rows)) {
      const i = parseInt(k, 10);
      if (Number.isFinite(i) && i >= 0 && i < 500) rows[i] = normPlanRowCfg(v);
    }
  }
  const plan = {
    seatW: clampNum(p.seatW, 0.4, 0.7, PLAN_DEFAULTS.seatW),
    headW: clampNum(p.headW, 0.1, 0.35, PLAN_DEFAULTS.headW),
    activeTarget: Math.round(Number(p.activeTarget)),
    targets, rows,
  };
  if (!targets.some((t) => t.id === plan.activeTarget)) plan.activeTarget = targets[0].id;
  return plan;
}

function getPlanRowCfg(plan, i) {
  const o = plan.rows[i];
  return o ? { ...PLAN_DEFAULTS.rowCfg, ...o } : { ...PLAN_DEFAULTS.rowCfg };
}
function setPlanRowCfg(i, patch) {
  state.plan.rows[i] = normPlanRowCfg({ ...getPlanRowCfg(state.plan, i), ...patch });
}
function activePlanTarget(plan) {
  return plan.targets.find((t) => t.id === plan.activeTarget) || plan.targets[0];
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

// 严格分级：只依据真实净空值，达到阈值才算合格。
// EPS=1e-9（纳米级）仅用于消除二进制浮点表示误差，不构成会接纳真实低值的容差区间——
// 与阈值相差超过 1e-9 m 的真实值一律按其数学大小判级（0.1196/0.1197 < 0.120 → 偏差）。
const RISK_EPS = 1e-9;
function classifyRisk(v, cMin, cGood) {
  if (v < -RISK_EPS) return RISK.BLOCK;
  if (v < cMin - RISK_EPS) return RISK.BAD;
  if (v < cGood - RISK_EPS) return RISK.WARN;
  return RISK.GOOD;
}

// C 值显示：默认毫米（3 位小数）；若毫米四舍五入会跨过判定档位
// （如真实 0.1196 舍成 0.120 却仍判偏差），则自动多显示一位（0.1196），
// 保证“显示数值—风险标记—报告文字”口径一致，不用舍入值倒推结论。
function formatC(v, s) {
  if (v === null || v === undefined) return "—";
  const ss = s || state.settings;
  const fixed3 = Math.round(v * 1000) / 1000;
  if (classifyRisk(v, ss.cMin, ss.cGood) !== classifyRisk(fixed3, ss.cMin, ss.cGood)) {
    return v.toFixed(4);
  }
  return fixed3.toFixed(3);
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
    const j = list[bestJ];

    // cur.c 始终保存“真实几何净空”（遮挡平面处，未做任何取整）。
    // 分级只依据真实值，严格阈值、不设毫米级容差；仅用 1e-9（纳米级）
    // 吸收二进制浮点表示误差，不会接纳任何真实低值：
    //   C < 0            已遮挡
    //   C < 最低限值      遮挡风险
    //   C < 目标值        偏差（真实值 0.1196/0.1197 虽显示 0.120 仍判偏差）
    //   C ≥ 目标值        合格（真实值达到 0.120000 才合格）
    cur.c = best;
    cur.worst = bestJ;

    // 观众视线擦过 j 排头顶 E_n→H_j 延伸到舞台平面 x=0 处的高度 y0，
    // 舞台面上 0～y0 即为该排被遮挡范围（遮挡平面净空为负时 V 本身不可见）。
    const slope = (j.headY - cur.eyeY) / (j.x - cur.x);
    cur.rayY0 = cur.eyeY + slope * (0 - cur.x);
    cur.blockedH = Math.max(0, cur.rayY0);

    cur.risk = classifyRisk(best, s.cMin, s.cGood);
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

/* ============================================================
   平面布置：横向视线校核
   ============================================================ */

// 排内平面几何：排占地 = 左过道 + 座位块 + 右过道，整体以厅中线 x=0 为中心，
// 因此左右过道宽度直接决定座位块的横向位置（过道加宽一侧会把座位推向另一侧）；
// 错排 stagger 以“节距（座宽+间距）”为单位，在此基础上看作整排（含过道）横移。
function planRowGeometry(plan, cfg) {
  const w = plan.seatW, g = cfg.gap, n = cfg.seats;
  const pitch = w + g;
  const blockW = n * w + (n - 1) * g;
  const staggerM = cfg.stagger * pitch;
  const rowW = cfg.aisleL + blockW + cfg.aisleR;   // 排占地总宽（过道 + 座位块）
  const blockStart = -rowW / 2 + cfg.aisleL + staggerM;
  const blockEnd = blockStart + blockW;
  const startCx = blockStart + w / 2;
  const seats = [];
  for (let k = 0; k < n; k++) seats.push({ k, cx: startCx + k * pitch, w });
  return {
    n, w, g, pitch, blockW, staggerM, startCx, seats,
    blockStart, blockEnd, rowW,
    x0: blockStart - cfg.aisleL, x1: blockEnd + cfg.aisleR,
    aisleL: cfg.aisleL, aisleR: cfg.aisleR,
  };
}

// 前排均匀布置下，横向位置 yLat 处最近的头部（节距均匀，下标取整即最近者，端部截断）
function nearestHead(geo, yLat, headW) {
  const k = clamp(Math.round((yLat - geo.startCx) / geo.pitch), 0, geo.n - 1);
  const cx = geo.startCx + k * geo.pitch;
  return { clear: Math.abs(yLat - cx) - headW / 2, k, cx };
}

// 逐座位横向视线：眼位横向 cx → 目标点 T(tx) 的连线，在遮挡平面（前排眼位平面
// y_j）处的横向位置 xS = tx + (cx−tx)·y_j/y_n；净空 = xS 与最近前座头中心的横向
// 距离 − 头宽/2。取全部前排中最小净空为该座位横向净空，判定沿用 C 值阈值（严格口径）。
function computePlan(res, plan, settings) {
  const target = activePlanTarget(plan);
  const geos = {};
  const occRows = res.list.filter((r) => r.occupied);
  occRows.forEach((r) => { geos[r.i] = planRowGeometry(plan, getPlanRowCfg(plan, r.i)); });

  const rows = res.list.map((r) => {
    if (!r.occupied) return { i: r.i, type: r.type, occupied: false };
    const geo = geos[r.i];
    const seats = geo.seats.map((seat) => {
      let best = Infinity, bj = -1, bk = -1, bcx = 0;
      for (const fj of occRows) {
        if (fj.i >= r.i) break;
        const yLat = target.x + (seat.cx - target.x) * (fj.x / r.x);
        const nh = nearestHead(geos[fj.i], yLat, plan.headW);
        if (nh.clear < best) { best = nh.clear; bj = fj.i; bk = nh.k; bcx = nh.cx; }
      }
      return {
        k: seat.k, cx: seat.cx, w: seat.w,
        clear: bj < 0 ? null : best, blockerRow: bj, blockerSeat: bk, blockerCx: bcx,
        risk: bj < 0 ? RISK.GOOD : classifyRisk(best, settings.cMin, settings.cGood),
      };
    });
    const counts = { good: 0, warn: 0, bad: 0, block: 0 };
    let worst = Infinity, worstK = -1;
    seats.forEach((st) => {
      counts[st.risk]++;
      if (st.clear !== null && st.clear < worst) { worst = st.clear; worstK = st.k; }
    });
    return { i: r.i, type: r.type, occupied: true, geo, seats, counts,
      worstClear: worst === Infinity ? null : worst, worstSeat: worstK };
  });

  const totals = { good: 0, warn: 0, bad: 0, block: 0, seats: 0 };
  let worstClear = null, worstRow = -1, worstSeat = -1;
  rows.forEach((ro) => {
    if (!ro.occupied) return;
    totals.seats += ro.seats.length;
    for (const k of ["good", "warn", "bad", "block"]) totals[k] += ro.counts[k];
    if (ro.worstClear !== null && (worstClear === null || ro.worstClear < worstClear)) {
      worstClear = ro.worstClear; worstRow = ro.i; worstSeat = ro.worstSeat;
    }
  });
  return { target, rows, totals, worstClear, worstRow, worstSeat };
}

// 各目标点分别全厅计算（用于“最不利方向”切换、保存快照与报告汇总）
function planTargetRanking(res, plan, settings) {
  return plan.targets.map((t) => {
    const cp = computePlan(res, { ...plan, activeTarget: t.id }, settings);
    return { target: t, worstClear: cp.worstClear, totals: cp.totals };
  });
}

function worstTargetId(ranking) {
  let id = -1, val = Infinity;
  ranking.forEach((r) => {
    if (r.worstClear !== null && r.worstClear < val) { val = r.worstClear; id = r.target.id; }
  });
  return id;
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
        c.fillText("C=" + formatC(row.c), px + 6, (topY + botY) / 2 + 4);
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
   Canvas 平面布置图绘制
   ============================================================ */

const planCanvas = $("plan-canvas");

function buildPlanView(W, H, res, planRes) {
  let half = 2.2;
  planRes.rows.forEach((ro) => {
    if (ro.occupied) half = Math.max(half, Math.abs(ro.geo.x0), Math.abs(ro.geo.x1));
  });
  state.plan.targets.forEach((t) => { half = Math.max(half, Math.abs(t.x) + 0.8); });
  half += 0.9;                                   // 排号 / 座位数标注空间
  const stageH = clamp((res.totalDepth || 6) * 0.12, 0.9, 2.2);
  const ymin = -stageH, ymax = (res.totalDepth || 6) + 0.7;
  const pad = 16;
  const sc = Math.min((W - pad * 2) / (half * 2), (H - pad * 2) / (ymax - ymin));
  const ox = W / 2;                              // 厅中线 x=0 的屏幕 x
  const P = (x, y) => [ox + x * sc, pad + (y - ymin) * sc];
  return { W, H, pad, sc, ox, half, ymin, ymax, stageH, P };
}

function renderPlanCanvas(cv, cssW, cssH, dpr, res, planRes, interactive) {
  const c = cv.getContext("2d");
  if (cv.width !== Math.round(cssW * dpr)) cv.width = Math.round(cssW * dpr);
  if (cv.height !== Math.round(cssH * dpr)) cv.height = Math.round(cssH * dpr);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = buildPlanView(cssW, cssH, res, planRes);
  const P = v.P;
  c.clearRect(0, 0, cssW, cssH);
  c.fillStyle = "#fbfbf8"; c.fillRect(0, 0, cssW, cssH);

  // ---- 横向网格（每 1m）+ 厅中线 ----
  c.font = "9px sans-serif";
  const [, gy0] = P(0, v.ymin), [, gy1] = P(0, v.ymax);
  for (let gx = Math.ceil(-v.half); gx <= v.half; gx++) {
    const [sx] = P(gx, 0);
    c.strokeStyle = gx === 0 ? "#b9c2cf" : "#e6e9ee";
    c.lineWidth = gx === 0 ? 1.3 : 1;
    c.beginPath(); c.moveTo(sx, gy0); c.lineTo(sx, gy1); c.stroke();
    if (gx !== 0) { c.fillStyle = "#9aa6b5"; c.fillText(String(gx), sx - 3, gy1 - 4); }
  }

  // ---- 舞台带 + 台口线 ----
  {
    const [lx, ty] = P(-v.half, v.ymin);
    const [rx, by] = P(v.half, 0);
    c.fillStyle = "#ded7c8"; c.fillRect(lx, ty, rx - lx, by - ty);
    c.save(); c.beginPath(); c.rect(lx, ty, rx - lx, by - ty); c.clip();
    c.strokeStyle = "rgba(150,138,114,.45)"; c.lineWidth = 1;
    for (let s = lx - (by - ty); s < rx + 20; s += 9) {
      c.beginPath(); c.moveTo(s, by); c.lineTo(s + (by - ty), ty); c.stroke();
    }
    c.restore();
    c.fillStyle = "#7c705c"; c.font = "bold 12px sans-serif";
    c.fillText("舞台", lx + 8, ty + 16);
    c.strokeStyle = "#a8412f"; c.setLineDash([6, 3]); c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(lx, by); c.lineTo(rx, by); c.stroke(); c.setLineDash([]);
    c.fillStyle = "#a8412f"; c.font = "10px sans-serif";
    c.fillText("台口线 y=0", rx - 66, by - 5);
  }

  const plan = state.plan;
  const target = planRes.target;

  // ---- 舞台目标点标记（可拖）----
  plan.targets.forEach((t) => {
    const [sx, sy] = P(t.x, 0);
    const active = t.id === target.id;
    const hov = interactive && planHover && planHover.kind === "target" && planHover.id === t.id;
    c.beginPath();
    c.moveTo(sx, sy + 2); c.lineTo(sx - 7, sy - 10); c.lineTo(sx + 7, sy - 10); c.closePath();
    c.fillStyle = active ? "#c64b3c" : "#8ea0b8";
    c.globalAlpha = active ? 1 : 0.75; c.fill(); c.globalAlpha = 1;
    if (hov || active) { c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke(); }
    const label = t.name + " " + (t.x >= 0 ? "+" : "") + r2(t.x);
    c.fillStyle = active ? "#a8412f" : "#6b788c";
    c.font = (active ? "bold " : "") + "10px sans-serif";
    c.fillText(label, sx - c.measureText(label).width / 2, sy - 14);
  });

  // ---- 逐排：通道 / 过道 / 座位 ----
  res.list.forEach((row) => {
    const yA = res.dxs[row.i], yB = yA + row.depth;
    const [bx0, syA] = P(-v.half, yA);
    const [bx1, syB] = P(v.half, yB);
    const bandH = syB - syA;
    const sel = interactive && row.i === selected;

    if (sel) { c.fillStyle = "rgba(78,161,255,.10)"; c.fillRect(bx0, syA, bx1 - bx0, bandH); }
    c.strokeStyle = "#dfe4ea"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(bx0, syA); c.lineTo(bx1, syA); c.stroke();

    // 排号（行列编号）
    c.fillStyle = row.occupied ? "#33415c" : "#8a97a8"; c.font = "bold 10px sans-serif";
    c.fillText("R" + (row.i + 1), bx0 + 3, (syA + syB) / 2 + 3);

    if (!row.occupied) {
      c.save(); c.beginPath(); c.rect(bx0, syA, bx1 - bx0, bandH); c.clip();
      c.strokeStyle = "rgba(120,132,150,.5)"; c.lineWidth = 1;
      for (let s = bx0 - bandH; s < bx1 + bandH; s += 9) {
        c.beginPath(); c.moveTo(s, syB); c.lineTo(s + bandH, syA); c.stroke();
      }
      c.restore();
      c.fillStyle = "#6b788c"; c.font = "10px sans-serif";
      c.fillText("横向通道", (bx0 + bx1) / 2 - 20, (syA + syB) / 2 + 3);
      return;
    }

    const ro = planRes.rows[row.i];
    const geo = ro.geo;
    const seatYA = syA + bandH * 0.16, seatYB = syB - bandH * 0.16;

    // 左右过道（含拖拽把手）
    const hovL = interactive && planHover && planHover.kind === "gripL" && planHover.i === row.i;
    const hovR = interactive && planHover && planHover.kind === "gripR" && planHover.i === row.i;
    drawPlanAisle(c, P, geo.x0, geo.blockStart, seatYA, seatYB, geo.aisleL, hovL, "L");
    drawPlanAisle(c, P, geo.blockEnd, geo.x1, seatYA, seatYB, geo.aisleR, hovR, "R");

    // 座位（遮挡热力 / 白底描边两种显示）
    ro.seats.forEach((st) => {
      const [sx0] = P(st.cx - st.w / 2, 0);
      const [sx1] = P(st.cx + st.w / 2, 0);
      const isSel = sel && selectedSeat === st.k;
      const col = RISK_COLOR[st.risk];
      if (planHeat) {
        c.fillStyle = col; c.globalAlpha = st.clear === null ? 0.35 : 0.8;
        c.fillRect(sx0, seatYA, sx1 - sx0, seatYB - seatYA);
        c.globalAlpha = 1;
      } else {
        c.fillStyle = "#ffffff"; c.fillRect(sx0, seatYA, sx1 - sx0, seatYB - seatYA);
      }
      c.strokeStyle = isSel ? "#1d4ed8" : col;
      c.lineWidth = isSel ? 2.4 : 1;
      c.strokeRect(sx0, seatYA, sx1 - sx0, seatYB - seatYA);
      // 座号
      if (sx1 - sx0 >= 11 && seatYB - seatYA >= 10) {
        const label = String(st.k + 1);
        c.fillStyle = planHeat ? "#ffffff" : "#33415c";
        c.font = "8px sans-serif";
        c.fillText(label, (sx0 + sx1) / 2 - c.measureText(label).width / 2, (seatYA + seatYB) / 2 + 3);
      }
      // 本排最差座位标记
      if (ro.worstSeat === st.k && ro.worstClear !== null) {
        const mx = (sx0 + sx1) / 2;
        c.fillStyle = "#c0271f";
        c.beginPath();
        c.moveTo(mx, seatYA - 1.5); c.lineTo(mx - 4, seatYA - 7.5); c.lineTo(mx + 4, seatYA - 7.5);
        c.closePath(); c.fill();
      }
    });

    // 座位数标注（排右端）
    const [rxT] = P(geo.x1 + 0.08, 0);
    c.fillStyle = "#5a6b82"; c.font = "9px sans-serif";
    c.fillText(geo.n + " 座", rxT, (syA + syB) / 2 + 3);
  });

  // ---- 选中座位：视线 → 目标点，遮挡者圈出 ----
  if (interactive && selected >= 0 && selectedSeat >= 0) {
    const ro = planRes.rows[selected];
    const row = res.list[selected];
    const st = ro && ro.occupied ? ro.seats[selectedSeat] : null;
    if (st && row) {
      const [ex, ey] = P(st.cx, row.x);
      const [tx, ty] = P(target.x, 0);
      c.strokeStyle = "#1d4ed8"; c.lineWidth = 1.6; c.setLineDash([6, 3]);
      c.beginPath(); c.moveTo(ex, ey); c.lineTo(tx, ty); c.stroke(); c.setLineDash([]);
      if (st.blockerRow >= 0) {
        const brow = res.list[st.blockerRow];
        const [hx, hy] = P(st.blockerCx, brow.x);
        c.strokeStyle = RISK_COLOR[st.risk]; c.lineWidth = 2;
        c.beginPath(); c.arc(hx, hy, Math.max(5, state.plan.headW / 2 * v.sc), 0, Math.PI * 2); c.stroke();
        const label = "净空 " + formatC(st.clear) + " ← R" + (st.blockerRow + 1) + "·" + (st.blockerSeat + 1) + "号";
        c.fillStyle = "#1d2530"; c.font = "bold 11px sans-serif";
        c.fillText(label, hx + 8, hy - 8);
      }
    }
  }

  drawPlanLegend(c, cssW, cssH);
  return v;
}

function drawPlanAisle(c, P, x0, x1, yA, yB, w, hov, side) {
  if (w <= 0.005) return;
  const [ax] = P(x0, 0), [bx] = P(x1, 0);
  c.save(); c.beginPath(); c.rect(ax, yA, bx - ax, yB - yA); c.clip();
  c.fillStyle = "rgba(142,160,184,.10)"; c.fillRect(ax, yA, bx - ax, yB - yA);
  c.strokeStyle = "rgba(120,132,150,.55)"; c.lineWidth = 1;
  const h = yB - yA;
  for (let s = ax - h; s < bx + h; s += 8) {
    c.beginPath(); c.moveTo(s, yB); c.lineTo(s + h, yA); c.stroke();
  }
  c.restore();
  if (bx - ax > 26) {
    const label = r2(w);
    c.fillStyle = "#6b788c"; c.font = "9px sans-serif";
    c.fillText(label, (ax + bx) / 2 - c.measureText(label).width / 2, (yA + yB) / 2 + 3);
  }
  // 拖拽把手（过道内缘 ║）
  const gx = side === "L" ? bx : ax;
  c.strokeStyle = hov ? "#e0523c" : "#7c8aa0"; c.lineWidth = hov ? 3 : 2;
  c.beginPath(); c.moveTo(gx, yA + 3); c.lineTo(gx, yB - 3); c.stroke();
}

function drawPlanLegend(c, W, H) {
  let x = 10; const y = H - 12;
  c.font = "10px sans-serif";
  c.fillStyle = "#5a6b82";
  c.fillText("横向净空：", x, y); x += 54;
  [["good", "合格"], ["warn", "偏差"], ["bad", "风险"], ["block", "遮挡"]].forEach(([k, label]) => {
    c.fillStyle = RISK_COLOR[k]; c.fillRect(x, y - 8, 10, 10);
    c.fillStyle = "#33415c"; c.fillText(label, x + 13, y);
    x += 13 + c.measureText(label).width + 12;
  });
  c.fillStyle = "#8a97a8";
  c.fillText("头宽 " + r2(state.plan.headW) + "m · 阈值沿用 C 值 " + r2(state.settings.cMin) +
    "/" + r2(state.settings.cGood) + "m", x + 6, y);
}

function drawPlan() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = planCanvas.clientWidth || 900, cssH = planCanvas.clientHeight || 400;
  planView = renderPlanCanvas(planCanvas, cssW, cssH, dpr,
    primaryDataset().res, currentPlan(), true);
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
  if (h.kind === "row") { selected = h.i; selectedSeat = -1; }
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
    if (!drag.moved && drag.kind === "row") { selected = drag.i; selectedSeat = -1; refresh(); }
    drag = null;
    canvas.style.cursor = hover ? "grab" : "crosshair";
  }
  if (planDrag) {
    planDrag = null;
    planCanvas.style.cursor = planHover ? "grab" : "crosshair";
  }
});

/* ============================================================
   平面图拖拽交互：座位→错排、过道把手→过道宽、目标点→横向位置
   ============================================================ */

let planHover = null;
let planDrag = null;

function planScreenToWorld(px, py) {
  const { sc, ox, pad, ymin } = planView;
  return { x: (px - ox) / sc, y: ymin + (py - pad) / sc };
}

function planHitTest(px, py) {
  if (!planView) return null;
  const res = primaryDataset().res;
  const planRes = currentPlan();
  const w = planScreenToWorld(px, py);
  // 目标点（台口线附近）优先
  for (const t of state.plan.targets) {
    const [tx, ty] = planView.P(t.x, 0);
    if (Math.hypot(px - tx, py - ty) <= 10) return { kind: "target", id: t.id };
  }
  // 逐排命中
  for (const row of res.list) {
    const yA = res.dxs[row.i], yB = yA + row.depth;
    if (w.y < yA || w.y > yB) continue;
    if (!row.occupied) return { kind: "rowband", i: row.i };
    const geo = planRes.rows[row.i].geo;
    const gripTol = 8 / planView.sc;
    if (Math.abs(w.x - geo.blockStart) <= gripTol) return { kind: "gripL", i: row.i };
    if (Math.abs(w.x - geo.blockEnd) <= gripTol) return { kind: "gripR", i: row.i };
    for (const st of planRes.rows[row.i].seats) {
      if (Math.abs(w.x - st.cx) <= st.w / 2 + 0.02) return { kind: "seat", i: row.i, k: st.k };
    }
    return { kind: "rowband", i: row.i };
  }
  return null;
}

planCanvas.addEventListener("pointerdown", (e) => {
  const rect = planCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const h = planHitTest(px, py);
  if (!h) return;
  planCanvas.setPointerCapture(e.pointerId);
  const w = planScreenToWorld(px, py);
  planDrag = { ...h, moved: false, startPX: px, startPY: py, w0X: w.x, w0Y: w.y };
  if (h.kind === "seat" || h.kind === "rowband") {
    selected = h.i;
    selectedSeat = h.kind === "seat" ? h.k : -1;
    scrollRowIntoView(h.i);
  }
  if (h.kind === "seat" || h.kind === "gripL" || h.kind === "gripR") {
    planDrag.cfg0 = getPlanRowCfg(state.plan, h.i);
  }
  if (h.kind === "target") {
    const t = state.plan.targets.find((tt) => tt.id === h.id);
    planDrag.x0 = t ? t.x : 0;
  }
  planCanvas.style.cursor = "grabbing";
  refresh();
});

planCanvas.addEventListener("pointermove", (e) => {
  const rect = planCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;

  if (planDrag && planView) {
    const w = planScreenToWorld(px, py);
    if (Math.abs(px - planDrag.startPX) + Math.abs(py - planDrag.startPY) > 2) planDrag.moved = true;
    const dx = w.x - planDrag.w0X;
    const cm = (v) => Math.round(v * 100) / 100;
    if (planDrag.kind === "target") {
      // 目标点：横向位置（5cm 步进）
      const t = state.plan.targets.find((tt) => tt.id === planDrag.id);
      if (t) t.x = clamp(Math.round((planDrag.x0 + dx) * 20) / 20, -25, 25);
    } else if (planDrag.kind === "gripL") {
      // 左过道把手：向左拖过道加宽
      setPlanRowCfg(planDrag.i, { aisleL: cm(clamp(planDrag.cfg0.aisleL - dx, 0, 3)) });
    } else if (planDrag.kind === "gripR") {
      setPlanRowCfg(planDrag.i, { aisleR: cm(clamp(planDrag.cfg0.aisleR + dx, 0, 3)) });
    } else if (planDrag.kind === "seat") {
      // 座位：整排横移 = 错排偏移（单位：节距）
      const pitch = state.plan.seatW + planDrag.cfg0.gap;
      setPlanRowCfg(planDrag.i, {
        stagger: Math.round(clamp(planDrag.cfg0.stagger + dx / pitch, -1, 1) * 100) / 100,
      });
    }
    persist();
    refresh();
    return;
  }

  const h = planHitTest(px, py);
  const changed = JSON.stringify(h) !== JSON.stringify(planHover);
  planHover = h;
  planCanvas.style.cursor = !h ? "crosshair"
    : h.kind === "gripL" || h.kind === "gripR" ? "ew-resize"
    : h.kind === "target" ? "grab"
    : "pointer";
  if (changed) drawPlan();
});

function scrollRowIntoView(i) {
  const tr = $("rows-body").children[i];
  if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: "nearest" });
}

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

function currentPlan() {
  if (!planCache) planCache = computePlan(primaryDataset().res, state.plan, state.settings);
  return planCache;
}
function currentRanking() {
  if (!planRankingCache) planRankingCache = planTargetRanking(primaryDataset().res, state.plan, state.settings);
  return planRankingCache;
}

function refresh() {
  planCache = null;
  planRankingCache = null;
  const ds = primaryDataset();
  const datasets = [ds, ...compareDatasets()];
  renderSummary(ds.res);
  renderRows(ds.res, false);
  view = drawScene(canvas, datasets, { interactive: true });
  drawPlan();
  renderPlanPanel();
  renderLayoutList();
  renderComparePicker();
}

function renderSummary(res) {
  const c = res.counts;
  const pr = currentPlan();
  const t = pr.totals;
  $("summary").innerHTML = `
    <span class="stat"><b>${res.list.length}</b>排（座 ${c.seat} · 轮椅 ${c.wheel} · 通道 ${c.aisle}）</span>
    <span class="stat">总进深 <b>${r2(res.totalDepth)}</b>m</span>
    <span class="stat">最高楼面 <b>${r2(res.maxElev)}</b>m</span>
    <span class="stat">最高眼位 <b>${r2(res.maxEye)}</b>m</span>
    <span class="stat">合格 <b class="good">${c.good}</b></span>
    <span class="stat">偏差 <b class="warn">${c.warn}</b></span>
    <span class="stat">风险 <b class="bad">${c.bad}</b></span>
    <span class="stat">已遮挡 <b class="block">${c.block}</b></span>
    <span class="stat">最差 C <b class="${res.worstC !== null && classifyRisk(res.worstC, state.settings.cMin, state.settings.cGood) === RISK.GOOD ? "good" : "bad"}">${res.worstC === null ? "—" : formatC(res.worstC)}</b>m</span>
    <span class="stat">平面 ${esc(pr.target.name)}：${t.seats} 座 · 合格 <b class="good">${t.good}</b> · 偏差 <b class="warn">${t.warn}</b> · 风险 <b class="bad">${t.bad}</b> · 遮挡 <b class="block">${t.block}</b></span>
    <span class="stat">最差横向净空 <b class="${pr.worstClear !== null && classifyRisk(pr.worstClear, state.settings.cMin, state.settings.cGood) === RISK.GOOD ? "good" : "bad"}">${pr.worstClear === null ? "—" : formatC(pr.worstClear)}</b>m</span>
  `;
}

const TYPE_LABEL = { seat: "普通座席", wheel: "轮椅位", aisle: "通道" };

function renderRows(res, rebuild) {
  const body = $("rows-body");
  if (rebuild || body.children.length !== state.rows.length) {
    body.innerHTML = "";
    state.rows.forEach((row, i) => body.appendChild(buildRowEl(row, i)));
  }
  const planRes = currentPlan();
  // 刷新计算列与选中态
  res.list.forEach((r, i) => {
    const tr = body.children[i];
    if (!tr) return;
    tr.classList.toggle("selected", i === selected);
    tr.classList.toggle("locked-row", !!r.locked);
    tr.querySelector("[data-c]").innerHTML = cCell(r);
    tr.querySelector("[data-plan-c]").innerHTML = planCell(planRes.rows[i]);
    tr.querySelector("[data-block]").textContent =
      r.occupied && r.worst >= 0 ? (r.blockedH > 0.005 ? r2(r.blockedH) + " m" : "0") : "—";
    tr.querySelector("[data-x]").textContent = r2(r.x);
  });
}

function planCell(pro) {
  if (!pro || !pro.occupied) return `<span class="badge aisle">通道</span>`;
  if (pro.worstClear === null) return `— <span class="badge good">首排</span>`;
  const risk = classifyRisk(pro.worstClear, state.settings.cMin, state.settings.cGood);
  return `<b>${formatC(pro.worstClear)}</b> <span class="badge ${risk}">${RISK_LABEL[risk]}</span>`;
}

function cCell(r) {
  if (r.type === "aisle") return `<span class="badge aisle">通道</span>`;
  if (r.worst < 0) return `— <span class="badge good">首排无遮挡</span>`;
  return `<b>${formatC(r.c)}</b> <span class="badge ${r.risk}">${RISK_LABEL[r.risk]}</span>`;
}

function buildRowEl(row, i) {
  const tr = document.createElement("tr");
  tr.dataset.i = i;
  const elevDisabled = row.type === "aisle" ? "disabled" : (row.locked ? "disabled" : "");
  const lockDisabled = row.type === "aisle" ? "disabled" : "";
  const pcfg = getPlanRowCfg(state.plan, i);
  const seatsCell = row.type === "aisle" ? "—"
    : `<input type="number" class="num-input sm" step="1" min="2" max="60"
        data-planfield="seats" value="${pcfg.seats}" title="本排座位数">`;
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
    <td>${seatsCell}</td>
    <td><input type="number" class="num-input" step="0.01" data-field="elev"
        ${elevDisabled} value="${r2(row.elev)}"></td>
    <td data-x></td>
    <td data-c></td>
    <td data-plan-c></td>
    <td data-block></td>
    <td style="text-align:center">
      <input type="checkbox" data-field="locked" ${row.locked ? "checked" : ""} ${lockDisabled}>
    </td>
    <td><button type="button" class="del-btn" title="删除本排">✕</button></td>
  `;

  tr.addEventListener("click", (e) => {
    if (e.target.closest("input,select,button")) return;
    selected = i; selectedSeat = -1; refresh();
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
  const seatsEl = tr.querySelector('[data-planfield="seats"]');
  if (seatsEl) seatsEl.addEventListener("input", (e) => {
    const cur = getPlanRowCfg(state.plan, i);
    setPlanRowCfg(i, { seats: clampInt(parseInt(e.target.value, 10), 2, 60, cur.seats) });
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
    selectedSeat = -1;
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

/* ============================================================
   平面布置面板：目标点切换、选中排编辑器、逐座位详情
   ============================================================ */

function renderPlanPanel() {
  renderPlanSummary();
  renderTargetSwitch();
  renderTargetList(false);
  syncPlanGlobals();
  syncPlanEditor();
  renderPlanDetail();
}

function renderPlanSummary() {
  const pr = currentPlan();
  const t = pr.totals;
  $("plan-summary").innerHTML = `
    <span class="stat">目标点 <b>${esc(pr.target.name)}</b>（x=${r2(pr.target.x)}m）</span>
    <span class="stat">座位 <b>${t.seats}</b></span>
    <span class="stat">合格 <b class="good">${t.good}</b></span>
    <span class="stat">偏差 <b class="warn">${t.warn}</b></span>
    <span class="stat">风险 <b class="bad">${t.bad}</b></span>
    <span class="stat">遮挡 <b class="block">${t.block}</b></span>
    <span class="stat">最差横向净空 <b class="${pr.worstClear !== null && classifyRisk(pr.worstClear, state.settings.cMin, state.settings.cGood) === RISK.GOOD ? "good" : "bad"}">${pr.worstClear === null ? "—" : formatC(pr.worstClear)}</b>m${pr.worstRow >= 0 ? "（R" + (pr.worstRow + 1) + "·" + (pr.worstSeat + 1) + "号）" : ""}</span>
  `;
}

/* 目标点切换按钮：标注各方向最差净空，红圈提示最不利方向 */
function renderTargetSwitch() {
  const box = $("plan-target-switch");
  const ranking = currentRanking();
  const worstId = worstTargetId(ranking);
  box.innerHTML = "";
  ranking.forEach((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "target-btn" +
      (r.target.id === state.plan.activeTarget ? " active" : "") +
      (r.target.id === worstId ? " worst" : "");
    b.textContent = r.target.name + " · " + (r.worstClear === null ? "—" : formatC(r.worstClear));
    b.title = "最差横向净空 " + (r.worstClear === null ? "—" : formatC(r.worstClear)) + "m" +
      (r.target.id === worstId ? "（最不利方向）" : "");
    b.addEventListener("click", () => {
      state.plan.activeTarget = r.target.id;
      persist(); refresh();
    });
    box.appendChild(b);
  });
}

/* 左栏目标点列表编辑 */
function renderTargetList(rebuild) {
  const box = $("target-list");
  if (rebuild || box.children.length !== state.plan.targets.length) {
    box.innerHTML = "";
    state.plan.targets.forEach((t) => box.appendChild(buildTargetEl(t)));
  }
  state.plan.targets.forEach((t, idx) => {
    const row = box.children[idx];
    if (!row) return;
    const radio = row.querySelector(".t-radio");
    if (radio) radio.checked = t.id === state.plan.activeTarget;
    const nameEl = row.querySelector(".t-name");
    if (nameEl && document.activeElement !== nameEl && nameEl.value !== t.name) nameEl.value = t.name;
    const xEl = row.querySelector(".t-x");
    if (xEl && document.activeElement !== xEl) xEl.value = r2(t.x);
  });
}

function buildTargetEl(t) {
  const div = document.createElement("div");
  div.className = "target-item";
  div.innerHTML = `
    <input type="radio" class="t-radio" name="active-target" title="设为当前校核目标点"
      ${t.id === state.plan.activeTarget ? "checked" : ""}>
    <input type="text" class="t-name" value="${esc(t.name)}" maxlength="20">
    <input type="number" class="t-x" step="0.05" min="-25" max="25" value="${r2(t.x)}" title="横向位置 x（m，中线为 0）">
    <button type="button" class="del-btn" title="删除目标点" ${state.plan.targets.length <= 1 ? "disabled" : ""}>✕</button>`;
  div.querySelector(".t-radio").addEventListener("change", () => {
    state.plan.activeTarget = t.id; persist(); refresh();
  });
  div.querySelector(".t-name").addEventListener("input", (e) => {
    t.name = e.target.value.slice(0, 20); persist();
  });
  div.querySelector(".t-name").addEventListener("change", () => refresh());
  div.querySelector(".t-x").addEventListener("input", (e) => {
    t.x = clamp(num(e.target, t.x), -25, 25); persist(); refresh();
  });
  div.querySelector(".del-btn").addEventListener("click", () => {
    if (state.plan.targets.length <= 1) return;
    state.plan.targets = state.plan.targets.filter((tt) => tt.id !== t.id);
    if (!state.plan.targets.some((tt) => tt.id === state.plan.activeTarget)) {
      state.plan.activeTarget = state.plan.targets[0].id;
    }
    persist(); refresh();
  });
  return div;
}

function syncPlanGlobals() {
  const sw = $("plan-seatw"), hw = $("plan-headw");
  if (document.activeElement !== sw) sw.value = r2(state.plan.seatW);
  if (document.activeElement !== hw) hw.value = r2(state.plan.headW);
}

/* 选中排平面参数编辑器 */
function syncPlanEditor() {
  const row = selected >= 0 ? state.rows[selected] : null;
  const ok = !!(row && isOcc(row));
  const cfg = ok ? getPlanRowCfg(state.plan, selected) : null;
  const map = {
    "plan-seats": cfg ? String(cfg.seats) : "",
    "plan-gap": cfg ? r2(cfg.gap) : "",
    "plan-stagger": cfg ? r2(cfg.stagger) : "",
    "plan-aislel": cfg ? r2(cfg.aisleL) : "",
    "plan-aisler": cfg ? r2(cfg.aisleR) : "",
  };
  Object.entries(map).forEach(([id, val]) => {
    const el = $(id);
    el.disabled = !ok;
    if (document.activeElement !== el) el.value = val;
  });
  $("plan-editor-hint").textContent = ok
    ? "正在编辑 R" + (selected + 1) + "（" + TYPE_LABEL[row.type] + "）"
    : "在剖面图、排表或平面图中选中一个座席排后编辑。";
}

/* 逐座位详情：横向视线结果 + 纵剖面排高与 C 值联动 */
function renderPlanDetail() {
  const el = $("plan-detail");
  const res = primaryDataset().res;
  const pr = currentPlan();
  const row = selected >= 0 ? res.list[selected] : null;
  if (!row) {
    el.innerHTML = `<span class="hint">点击平面图中的座位查看逐座位横向视线（遮挡者 / 净空 / 风险）；
      点击排空白处选中整排；选中行在上方纵剖面与排表中同步高亮。</span>`;
    return;
  }
  if (!row.occupied) {
    el.innerHTML = `<b>R${selected + 1}</b> 为横向通道，不参与视线校核。`;
    return;
  }
  const ro = pr.rows[selected];
  const secPart = `纵剖面：楼面标高 <b>${r2(row.floor)}</b>m · 眼位 <b>${r2(row.eyeY)}</b>m ·
    C 值 <b>${row.c === null ? "—" : formatC(row.c)}</b>m
    <span class="badge ${row.risk}">${row.worst < 0 ? "首排无遮挡" : RISK_LABEL[row.risk]}</span>`;
  if (selectedSeat < 0 || !ro.seats[selectedSeat]) {
    el.innerHTML = `<b>R${selected + 1}</b>（${ro.geo.n} 座）整排：横向最差净空
      <b>${ro.worstClear === null ? "—" : formatC(ro.worstClear)}</b>m${ro.worstSeat >= 0 ? "（" + (ro.worstSeat + 1) + " 号座）" : ""}
      　|　${secPart}`;
    return;
  }
  const st = ro.seats[selectedSeat];
  const blk = st.blockerRow >= 0
    ? `遮挡者 <b>R${st.blockerRow + 1}·${st.blockerSeat + 1}号</b>（横向 ${r2(st.blockerCx)}m）`
    : "无遮挡者（首排）";
  el.innerHTML = `<b>R${selected + 1}·${selectedSeat + 1}号座</b>（横向 ${r2(st.cx)}m）→
    目标点 ${esc(pr.target.name)}：横向净空 <b>${st.clear === null ? "—" : formatC(st.clear)}</b>m
    <span class="badge ${st.risk}">${st.clear === null ? "首排" : RISK_LABEL[st.risk]}</span>
    　${blk}　|　${secPart}`;
}

function bindPlan() {
  // 全局座位参数
  $("plan-seatw").addEventListener("input", (e) => {
    state.plan.seatW = clampNum(parseFloat(e.target.value), 0.4, 0.7, state.plan.seatW);
    persist(); refresh();
  });
  $("plan-headw").addEventListener("input", (e) => {
    state.plan.headW = clampNum(parseFloat(e.target.value), 0.1, 0.35, state.plan.headW);
    persist(); refresh();
  });

  // 选中排平面参数
  const bindCfg = (id, key, lo, hi, isInt) => {
    $(id).addEventListener("input", (e) => {
      if (selected < 0 || !isOcc(state.rows[selected])) return;
      const cur = getPlanRowCfg(state.plan, selected);
      const v = isInt
        ? clampInt(parseInt(e.target.value, 10), lo, hi, cur[key])
        : clampNum(parseFloat(e.target.value), lo, hi, cur[key]);
      setPlanRowCfg(selected, { [key]: v });
      persist(); refresh();
    });
  };
  bindCfg("plan-seats", "seats", 2, 60, true);
  bindCfg("plan-gap", "gap", 0, 0.3, false);
  bindCfg("plan-stagger", "stagger", -1, 1, false);
  bindCfg("plan-aislel", "aisleL", 0, 3, false);
  bindCfg("plan-aisler", "aisleR", 0, 3, false);

  $("btn-apply-plan-all").addEventListener("click", () => {
    if (selected < 0 || !isOcc(state.rows[selected])) {
      alert("请先在剖面图、排表或平面图中选中一个座席排");
      return;
    }
    const cfg = getPlanRowCfg(state.plan, selected);
    state.rows.forEach((r, i) => { if (isOcc(r)) state.plan.rows[i] = { ...cfg }; });
    persist(); refresh();
  });

  // 目标点
  $("btn-add-target").addEventListener("click", () => {
    const id = Math.max(0, ...state.plan.targets.map((t) => t.id)) + 1;
    state.plan.targets.push({ id, name: "目标点 " + id, x: 0 });
    persist(); refresh();
  });
  $("btn-worst-target").addEventListener("click", () => {
    const id = worstTargetId(currentRanking());
    if (id >= 0) { state.plan.activeTarget = id; persist(); refresh(); }
  });

  // 遮挡热力开关
  $("plan-heat").checked = planHeat;
  $("plan-heat").addEventListener("change", (e) => {
    planHeat = !!e.target.checked;
    refresh();
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
    savedId = null; selected = -1; selectedSeat = -1;
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

function planSeatTotal(data) {
  const plan = normPlan(data.plan);
  return (data.rows || []).reduce((t, r, i) => {
    const type = r && r.type ? r.type : "seat";
    return t + (type === "aisle" ? 0 : getPlanRowCfg(plan, i).seats);
  }, 0);
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
    const nSeats = planSeatTotal(l.data);
    div.innerHTML = `
      <div class="li-name"><span>📁 ${esc(l.name)}</span></div>
      <div class="li-meta">${nRows} 排 · ${nSeats} 座 · 更新于 ${fmtTime(l.updated_at)}</div>
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
    plan: normPlan(l.data.plan),
  };
  selected = -1;
  selectedSeat = -1;
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

/* 随布置保存的校核结果快照：纵剖面汇总 + 各目标点横向汇总 */
function buildResultsSnapshot() {
  const res = primaryDataset().res;
  const ranking = planTargetRanking(res, state.plan, state.settings);
  return {
    savedAt: Date.now() / 1000,
    section: {
      worstC: res.worstC, counts: res.counts,
      totalDepth: res.totalDepth, maxElev: res.maxElev,
    },
    plan: {
      seatW: state.plan.seatW, headW: state.plan.headW,
      targets: ranking.map((r) => ({
        name: r.target.name, x: r.target.x,
        worstClear: r.worstClear, counts: r.totals,
      })),
    },
  };
}

function bindSave() {
  $("layout-name").addEventListener("input", (e) => { state.name = e.target.value; });
  $("layout-note").addEventListener("input", (e) => { state.note = e.target.value; });

  $("btn-save").addEventListener("click", async () => {
    const name = $("layout-name").value.trim();
    if (!name) { flash("请先填写布置名称"); return; }
    state.name = name; state.note = $("layout-note").value;
    const payload = {
      name, note: state.note,
      data: {
        settings: state.settings, rows: state.rows, plan: state.plan,
        results: buildResultsSnapshot(),
      },
    };
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
          <td style="color:${RISK_COLOR[r.risk]};font-weight:700">${r.c === null ? "—" : formatC(r.c, d.settings)}${c0}</td>
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
    <li><b>判定阈值（严格）</b>：分级只依据<b>未经取整的真实净空</b>，达到阈值才算合格，不设毫米级容差——
        C ≥ ${r3(s.cGood)} m 合格（真实值须达到 ${r3(s.cGood)}，如 0.120000）；${r3(s.cMin)} ≤ C &lt; ${r3(s.cGood)} m 为偏差
        （真实值低于 ${r3(s.cGood)} 即不合格，如 0.119600、0.119700 虽按毫米显示为 0.120，仍判偏差并以四位小数列出）；
        0 ≤ C &lt; ${r3(s.cMin)} m 为遮挡风险；C &lt; 0 视点被前座完全遮挡。设计常用 C=0.12 m，困难条件可取 0.06 m（JGJ 57-2016）。</li>
    <li><b>遮挡范围</b>：将 E<sub>n</sub> 与最不利排头顶的连线延长至舞台面 x=0，交点高度 y<sub>0</sub> 即舞台面上被遮挡的高度（0～y<sub>0</sub> 不可见）。</li>
    <li><b>自动起坡</b>：自首个有效排起按 C≥${r2(s.cGood)} m 逐排递推所需眼位，反求各排楼面标高；
        已锁定的固定楼板段保持原标高并作为后续排的切线基准；横向通道不作遮挡体，其楼面按相邻排线性插值。</li>
    <li><b>构造假设</b>：各排眼位位于该排进深中点所在视线平面；头眼高差对普通席与轮椅席取相同值；
        本项为纵向中轴剖面校核；横向偏座（越座视线）由下方平面校核补充，二者均未含墙体栏板遮挡。</li>`;
}

function planBasisLis(s, plan) {
  return `
    <li><b>平面坐标</b>：台口线为 y=0、厅中线为 x=0；座位以横向中心 cx 表示，座宽 ${r2(plan.seatW)} m、
        头部遮挡宽 ${r2(plan.headW)} m。每排可设座位数、横向间距、错排偏移（以“座宽+间距”为 1 节距）及左右过道宽。</li>
    <li><b>横向视线（逐座位）</b>：座位眼位横向 cx 与舞台目标点 T(x<sub>T</sub>) 的连线，在遮挡平面
        （前排眼位平面 y<sub>j</sub>）处的横向位置 x<sub>S</sub> = x<sub>T</sub> + (cx − x<sub>T</sub>)·y<sub>j</sub>/y<sub>n</sub>；
        横向净空 = x<sub>S</sub> 与最近前座头中心的横向距离 − 头宽/2。取全部前排最小值为该座位横向净空。</li>
    <li><b>判定（严格）</b>：横向净空分级沿用纵剖面 C 值阈值（目标 ${r3(s.cGood)} m / 最低 ${r3(s.cMin)} m），
        同样以未取整真实值严格判定，不设毫米级容差。</li>
    <li><b>最不利方向</b>：对各舞台目标点分别全厅计算，最差横向净空最小者为最不利方向；
        逐座位明细按当前目标点给出，各目标点汇总见“目标点汇总”表。</li>
    <li><b>构造假设</b>：排内座位均匀布置、左右过道贴座位块两端；横向校核为眼位平面内一维几何，
        纵向高差遮挡已由剖面 C 值校核覆盖。</li>`;
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

/* 平面参数表：每排座位数 / 间距 / 错排 / 过道 */
function planParamsTable(res) {
  const head = `<tr><th>排</th><th>类型</th><th>座位数</th><th>座宽(m)</th><th>横向间距(m)</th>
    <th>错排(节距)</th><th>错排(m)</th><th>左过道(m)</th><th>右过道(m)</th><th>排总宽(m)</th></tr>`;
  const body = res.list.map((r) => {
    if (!r.occupied) return `<tr><td>${r.i + 1}</td><td>通道</td><td colspan="8">—</td></tr>`;
    const cfg = getPlanRowCfg(state.plan, r.i);
    const geo = planRowGeometry(state.plan, cfg);
    return `<tr><td>${r.i + 1}</td><td>${TYPE_LABEL[r.type]}</td><td>${cfg.seats}</td>
      <td>${r2(state.plan.seatW)}</td><td>${r2(cfg.gap)}</td>
      <td>${r2(cfg.stagger)}</td><td>${r2(geo.staggerM)}</td>
      <td>${r2(cfg.aisleL)}</td><td>${r2(cfg.aisleR)}</td><td>${r2(geo.x1 - geo.x0)}</td></tr>`;
  }).join("");
  return "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
}

/* 目标点汇总：各方向最差横向净空与风险分布 */
function planTargetTable(ranking) {
  const worstId = worstTargetId(ranking);
  const rows = ranking.map((r) => {
    const t = r.totals;
    const cls = r.worstClear !== null &&
      classifyRisk(r.worstClear, state.settings.cMin, state.settings.cGood) === RISK.GOOD ? "r-good" : "r-bad";
    return `<tr>
      <td>${esc(r.target.name)}${r.target.id === worstId ? "（最不利方向）" : ""}</td>
      <td>${r2(r.target.x)}</td>
      <td class="${cls}">${r.worstClear === null ? "—" : formatC(r.worstClear)}</td>
      <td class="r-good">${t.good}</td><td class="r-warn">${t.warn}</td>
      <td class="r-bad">${t.bad}</td><td class="r-block">${t.block}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>目标点</th><th>横向 x(m)</th><th>最差横向净空(m)</th>
    <th>合格</th><th>偏差</th><th>风险</th><th>遮挡</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* 逐座位横向视线明细（当前目标点） */
function seatDetailTable(planRes) {
  const head = `<tr><th>排</th><th>座号</th><th>横向位置(m)</th><th>横向净空(m)</th><th>遮挡者</th><th>判定</th></tr>`;
  const body = planRes.rows.map((ro) => {
    if (!ro.occupied) return `<tr><td>R${ro.i + 1}</td><td colspan="5">横向通道</td></tr>`;
    return ro.seats.map((st) => {
      const clear = st.clear === null ? "<td>—</td>" : `<td class="r-${st.risk}">${formatC(st.clear)}</td>`;
      const blk = st.blockerRow >= 0 ? `R${st.blockerRow + 1}·${st.blockerSeat + 1}号` : "—";
      const judge = st.clear === null
        ? `<td class="r-good">首排无遮挡</td>`
        : `<td class="r-${st.risk}">${RISK_LABEL[st.risk]}</td>`;
      return `<tr><td>R${ro.i + 1}</td><td>${st.k + 1}</td><td>${r2(st.cx)}</td>${clear}<td>${blk}</td>${judge}</tr>`;
    }).join("");
  }).join("");
  return "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
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
        : `<td class="r-${r.risk}">${formatC(r.c)}</td><td class="r-${r.risk}">${RISK_LABEL[r.risk]}</td>`;
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
  drawSceneFixed(off, ds, 1600, 900);
  const dataUrl = off.toDataURL("image/png");

  // 平面布置图（离屏）
  const planRes = currentPlan();
  const ranking = currentRanking();
  const offPlan = document.createElement("canvas");
  offPlan.width = 1600; offPlan.height = 1000;
  renderPlanCanvas(offPlan, 1600, 1000, 1, res, planRes, false);
  const planUrl = offPlan.toDataURL("image/png");

  const c2 = res.counts;
  const pt = planRes.totals;
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
        <tr><th>全厅最差 C 值</th><td class="${res.worstC !== null && classifyRisk(res.worstC, state.settings.cMin, state.settings.cGood) === RISK.GOOD ? "r-good" : "r-bad"}">${res.worstC === null ? "—" : formatC(res.worstC)} m</td></tr>
      </table>
      <table>
        <tr><th>座宽 / 头部遮挡宽</th><td>${r2(state.plan.seatW)} m / ${r2(state.plan.headW)} m</td></tr>
        <tr><th>座位总数</th><td>${pt.seats} 座</td></tr>
        <tr><th>当前目标点</th><td>${esc(planRes.target.name)}（x=${r2(planRes.target.x)} m）</td></tr>
        <tr><th>横向 合格/偏差/风险/遮挡</th><td>${pt.good} / ${pt.warn} / ${pt.bad} / ${pt.block} 座</td></tr>
        <tr><th>全厅最差横向净空</th><td class="${planRes.worstClear !== null && classifyRisk(planRes.worstClear, state.settings.cMin, state.settings.cGood) === RISK.GOOD ? "r-good" : "r-bad"}">${planRes.worstClear === null ? "—" : formatC(planRes.worstClear)} m${planRes.worstRow >= 0 ? "（R" + (planRes.worstRow + 1) + "·" + (planRes.worstSeat + 1) + "号）" : ""}</td></tr>
      </table>
    </div>

    <h2>三、逐排计算结果（纵剖面）</h2>
    ${rowsResultTable(res)}

    <h2>四、平面布置与横向视线校核（当前目标点：${esc(planRes.target.name)}）</h2>
    <img class="diagram" src="${planUrl}">
    ${planParamsTable(res)}
    <h2>五、目标点汇总（最不利方向）</h2>
    ${planTargetTable(ranking)}

    <h2>六、逐座位横向视线明细（目标点：${esc(planRes.target.name)}）</h2>
    ${seatDetailTable(planRes)}

    <h2>七、计算依据与说明</h2>
    <ul>${calcBasisLis(state.settings)}${planBasisLis(state.settings, state.plan)}</ul>
    <div class="note">风险处置建议：对“偏差”排可优先微调后一排标高或加大排距；“遮挡风险/已遮挡”排应抬升本排楼面、
      增大错排或调整首排距离；横向遮挡座位可调整错排偏移、横向间距或过道位置，并按最不利目标点复核；
      锁定段为现状不可改楼板时，应在其后按本报告公式重新起坡并复校全部后排。</div>
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
      return `<td>${r2(r.floor)}</td><td class="r-${r.risk}">${r.c === null ? "—" : formatC(r.c, d.settings)}</td>
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
  console.log("用例9 遮挡平面真实 C =", r2row.c, " 显示=", formatC(r2row.c, s9));
  check("遮挡平面净空 = 0.100833 m（真实值，未取整）", Math.abs(r2row.c - 0.100833) < 1e-6, { c: r2row.c });
  check("显示 0.101（毫米，不会误显 0.121）", formatC(r2row.c, s9) === "0.101", { shown: formatC(r2row.c, s9) });
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

// ---------- 用例 10（严格阈值·刻度间边界回归）----------
// 构造 V=(0,1.0)、前排 x=5 头顶1.30、后排 x=6。
// 真实净空 C 与后排眼位一一对应：C = 1 + (eye2−1)·5/6 − 1.30
//   → eye2 = 1 + (C + 0.30)·6/5。楼面标高不取整，以精确命中目标真实 C。
function boundaryRows(cVal) {
  const sB = { ...s, vy: 1.0, firstDistance: 5.0, eyeHeight: 1.15, headHeight: 1.30,
    cGood: 0.120, cMin: 0.060 };
  const eye2 = 1 + (cVal + 0.30) * 6 / 5;
  const rowsB = [
    { type: "seat", depth: 1.0, elev: 0, locked: false },
    { type: "seat", depth: 1.0, elev: eye2 - sB.eyeHeight, locked: false },
  ];
  return { sB, resB: compute(sB, rowsB), rowsB };
}

// (a) 两位小数输入产生的真实 0.119700：取 cMin 无关，直接构造真实 C=0.1197；
//     0.1196/0.1197 按毫米都“显示 0.120”，但必须判偏差，界面给出四位小数。
for (const cVal of [0.119600, 0.119700]) {
  const { sB, resB } = boundaryRows(cVal);
  const rr = resB.list[1];
  console.log(`用例10 真实 C=${cVal.toFixed(6)} 计算=${rr.c.toFixed(6)} 显示="${formatC(rr.c, sB)}" 判定=${rr.risk}`);
  check(`真实 ${cVal.toFixed(6)} 几何值精确还原`, Math.abs(rr.c - cVal) < 1e-9, { c: rr.c });
  check(`真实 ${cVal.toFixed(6)} < 0.120 不得合格`, rr.risk !== "good", { risk: rr.risk });
  check(`真实 ${cVal.toFixed(6)} 判偏差 warn`, rr.risk === "warn", { risk: rr.risk });
  check(`真实 ${cVal.toFixed(6)} 显示四位小数 ${cVal.toFixed(4)}（而非 0.120）`,
    formatC(rr.c, sB) === cVal.toFixed(4), { shown: formatC(rr.c, sB) });
}

// (b) 真实达到 0.120000 才合格，显示 0.120
{
  const { sB, resB } = boundaryRows(0.120000);
  const rr = resB.list[1];
  console.log(`用例10 真实 C=0.120000 计算=${rr.c.toFixed(6)} 显示="${formatC(rr.c, sB)}" 判定=${rr.risk}`);
  check("真实 0.120000 几何值精确还原", Math.abs(rr.c - 0.12) < 1e-9, { c: rr.c });
  check("真实 0.120000 ≥ 0.120 判合格 good", rr.risk === "good", { risk: rr.risk });
  check("真实 0.120000 显示 0.120", formatC(rr.c, sB) === "0.120", { shown: formatC(rr.c, sB) });
}

// (c) 两位小数输入（0.12）在浮点意义下就是阈值：不得因 1e-16 表示误差判偏差
{
  const { sB, resB } = boundaryRows(0.12);
  check("两位小数输入 0.12 判合格（吸收浮点表示误差）", resB.list[1].risk === "good",
    { risk: resB.list[1].risk });
}

// (d) 1e-9 只吸收浮点噪声：真实 0.120−1e-6（差阈值 1 微米）仍须判偏差
{
  const { resB } = boundaryRows(0.12 - 1e-6);
  check("真实低于阈值 1 微米仍判偏差（无毫米容差）", resB.list[1].risk === "warn",
    { risk: resB.list[1].risk, c: resB.list[1].c });
}

// (e) 毫米级扫描保持：数值与标记随真实值严格变化（0.119 偏差 / 0.120/0.121 合格）
for (const [cT, good] of [[0.118, false], [0.119, false], [0.120, true], [0.121, true], [0.122, true]]) {
  const { resB } = boundaryRows(cT);
  check(`扫描真实 C=${cT.toFixed(3)} → ${good ? "合格" : "偏差"}`,
    (resB.list[1].risk === "good") === good, { risk: resB.list[1].risk });
}

// ---------- 用例 11：平面横向视线（几何与逐座位校核）----------
{
  const sP = { ...s, firstDistance: 4.5 };
  const rowsP = [
    { type: "seat", depth: 0.9, elev: 0 },
    { type: "seat", depth: 0.9, elev: 0.3 },
  ];
  const resP = compute(sP, rowsP);
  const plan = normPlan({
    targets: [{ id: 1, name: "中线", x: 0 }],
    activeTarget: 1,
    rows: {
      0: { seats: 3, gap: 0.04, stagger: 0, aisleL: 1, aisleR: 1 },
      1: { seats: 3, gap: 0.04, stagger: 0, aisleL: 1, aisleR: 1 },
    },
  });
  // 几何：3 座 → blockW = 3·0.52+2·0.04 = 1.64；对称过道时座位中心 -0.56/0/0.56
  const geo = planRowGeometry(plan, getPlanRowCfg(plan, 0));
  check("平面：blockW=1.64", Math.abs(geo.blockW - 1.64) < 1e-9);
  check("平面：对称过道座位中心 -0.56/0/0.56",
    Math.abs(geo.seats[0].cx + 0.56) < 1e-9 && Math.abs(geo.seats[1].cx) < 1e-9 &&
    Math.abs(geo.seats[2].cx - 0.56) < 1e-9);
  check("平面：排总宽=1.64+2=3.64", Math.abs(geo.rowW - 3.64) < 1e-9 &&
    Math.abs(geo.x1 - geo.x0 - 3.64) < 1e-9);

  const cp = computePlan(resP, plan, sP);
  check("平面：首排座位无遮挡者", cp.rows[0].seats.every((st) => st.clear === null && st.risk === "good"));
  // 第2排中座 cx=0：yLat=0 → 正对前排中座头中心，净空=-0.10 → 已遮挡
  const mid = cp.rows[1].seats[1];
  check("平面：中座净空=-0.10", Math.abs(mid.clear - (-0.10)) < 1e-9, { c: mid.clear });
  check("平面：中座判已遮挡", mid.risk === "block");
  check("平面：遮挡者为 R1·2号", mid.blockerRow === 0 && mid.blockerSeat === 1);

  // 错排 0.5：前排中心 ±0.28/0.84 → 中座净空 0.28−0.10=0.18 合格
  const plan2 = normPlan({ ...plan, rows: {
    0: { seats: 3, gap: 0.04, stagger: 0.5, aisleL: 1, aisleR: 1 },
    1: { seats: 3, gap: 0.04, stagger: 0, aisleL: 1, aisleR: 1 },
  } });
  const mid2 = computePlan(resP, plan2, sP).rows[1].seats[1];
  check("平面：错排0.5后中座净空=0.18", Math.abs(mid2.clear - 0.18) < 1e-9, { c: mid2.clear });
  check("平面：错排后判合格", mid2.risk === "good");

  // 目标点偏移 x=5：yLat = 5+(0−5)·4.5/5.4 = 0.8333 → 最近头 0.56 → 净空 0.1733
  const plan3 = normPlan({ ...plan, targets: [{ id: 9, name: "右侧", x: 5 }], activeTarget: 9 });
  const mid3 = computePlan(resP, plan3, sP).rows[1].seats[1];
  check("平面：目标点x=5时中座净空≈0.1733", Math.abs(mid3.clear - 0.173333) < 1e-4, { c: mid3.clear });

  check("平面：totals.seats=6", cp.totals.seats === 6);
  check("平面：worstRow=1", cp.worstRow === 1);
  const rk = planTargetRanking(resP, plan, sP);
  check("平面：ranking 汇总每个目标点", rk.length === 1 && rk[0].worstClear !== null);
}

// ---------- 用例 12（过道回归）：aisleL/aisleR 必须进入座位横向定位与遮挡路径 ----------
// 缺陷复盘：旧几何把座位块固定在厅中线，aisleL/aisleR 只外扩绘图边界，
// 三排 aisleL 0→3 时 24 个座位的 cx/clear/blockerRow/blockerSeat/risk 全部不变。
{
  const sA = { ...s, firstDistance: 4.5 };
  const rowsA = [
    { type: "seat", depth: 0.9, elev: 0 },
    { type: "seat", depth: 0.9, elev: 0.2 },
    { type: "seat", depth: 0.9, elev: 0.4 },
  ];
  const resA = compute(sA, rowsA);
  const mkPlan = (aisleL) => normPlan({
    targets: [{ id: 1, name: "中线", x: 0 }], activeTarget: 1,
    rows: {
      0: { seats: 8, gap: 0.04, stagger: 0, aisleL, aisleR: 0 },
      1: { seats: 8, gap: 0.04, stagger: 0, aisleL, aisleR: 0 },
      2: { seats: 8, gap: 0.04, stagger: 0, aisleL, aisleR: 0 },
    },
  });
  const pA = mkPlan(0), pB = mkPlan(3);
  const before = computePlan(resA, pA, sA);
  const after = computePlan(resA, pB, sA);
  check("过道回归：3 排 × 8 座 = 24 个座位", before.totals.seats === 24 && after.totals.seats === 24);

  // ① 排占地居中：aisleL 0→3 使全部座位 cx 平移 +1.50（过道增量的一半）
  let allShifted = true;
  for (let i = 0; i < 3; i++)
    for (let k = 0; k < 8; k++)
      if (Math.abs(after.rows[i].seats[k].cx - before.rows[i].seats[k].cx - 1.5) > 1e-9) allShifted = false;
  check("过道回归：aisleL 0→3 使 24 个座位 cx 全部 +1.50", allShifted);
  const geoA = planRowGeometry(pA, getPlanRowCfg(pA, 0));
  const geoB = planRowGeometry(pB, getPlanRowCfg(pB, 0));
  check("过道回归：x0 -2.22 → -3.72、座位块 -2.22 → -0.72",
    Math.abs(geoA.x0 + 2.22) < 1e-9 && Math.abs(geoB.x0 + 3.72) < 1e-9 &&
    Math.abs(geoB.blockStart + 0.72) < 1e-9, { x0: geoB.x0, bs: geoB.blockStart });

  // ② 手算复核 R2·1（row1·k0）：净空 0.1333 → -0.0233，合格 → 已遮挡
  const b21 = before.rows[1].seats[0], a21 = after.rows[1].seats[0];
  check("过道回归：R2·1 原净空≈0.1333 合格",
    Math.abs(b21.clear - 0.133333) < 1e-4 && b21.risk === "good", { c: b21.clear, risk: b21.risk });
  check("过道回归：R2·1 新净空≈-0.0233 已遮挡",
    Math.abs(a21.clear - (-0.023333)) < 1e-4 && a21.risk === "block", { c: a21.clear, risk: a21.risk });
  check("过道回归：R2·1 遮挡者座位号 1→0（同排）",
    b21.blockerRow === 0 && a21.blockerRow === 0 && b21.blockerSeat === 1 && a21.blockerSeat === 0);

  // ③ 手算复核 R3·2（row2·k1）：净空 0.06 → -0.0857，偏差 → 已遮挡，遮挡者换排
  const b32 = before.rows[2].seats[1], a32 = after.rows[2].seats[1];
  check("过道回归：R3·2 原净空≈0.0600 偏差",
    Math.abs(b32.clear - 0.06) < 1e-9 && b32.risk === "warn", { c: b32.clear, risk: b32.risk });
  check("过道回归：R3·2 新净空≈-0.0857 已遮挡",
    Math.abs(a32.clear - (-0.085714)) < 1e-4 && a32.risk === "block", { c: a32.clear, risk: a32.risk });
  check("过道回归：R3·2 遮挡者换排换座",
    b32.blockerRow === 0 && b32.blockerSeat === 2 && a32.blockerRow === 1 && a32.blockerSeat === 1);

  // ④ 全场汇总（热力/报告数据源）同步变化
  check("过道回归：前 合格12/偏差2/风险4/遮挡6",
    before.totals.good === 12 && before.totals.warn === 2 &&
    before.totals.bad === 4 && before.totals.block === 6, before.totals);
  check("过道回归：后 合格9/偏差3/风险3/遮挡9",
    after.totals.good === 9 && after.totals.warn === 3 &&
    after.totals.bad === 3 && after.totals.block === 9, after.totals);
  check("过道回归：全场最差净空变化", after.worstClear !== before.worstClear,
    { b: before.worstClear, a: after.worstClear });

  // ⑤ 只改前排过道：后排 cx 不变，但遮挡路径变 → 后排净空重算（0.1333→1.0733）
  const planOnlyRow0 = normPlan({
    targets: [{ id: 1, name: "中线", x: 0 }], activeTarget: 1,
    rows: {
      0: { seats: 8, gap: 0.04, stagger: 0, aisleL: 3, aisleR: 0 },
      1: { seats: 8, gap: 0.04, stagger: 0, aisleL: 0, aisleR: 0 },
      2: { seats: 8, gap: 0.04, stagger: 0, aisleL: 0, aisleR: 0 },
    },
  });
  const mixed = computePlan(resA, planOnlyRow0, sA);
  check("过道回归：只改前排过道时后排 cx 不变",
    Math.abs(mixed.rows[1].seats[0].cx - before.rows[1].seats[0].cx) < 1e-9);
  check("过道回归：后排净空随前排过道重算（0.1333→1.0733）",
    Math.abs(mixed.rows[1].seats[0].clear - 1.073333) < 1e-4,
    { c: mixed.rows[1].seats[0].clear });
}

console.log("\n结果：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);