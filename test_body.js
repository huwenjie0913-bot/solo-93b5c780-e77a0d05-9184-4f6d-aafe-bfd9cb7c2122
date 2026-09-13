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

console.log("\n结果：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
