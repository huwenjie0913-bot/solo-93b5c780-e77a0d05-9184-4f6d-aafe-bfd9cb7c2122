// 数值验证测试主体（与 app.js 源码拼接后运行）
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}

// ---------- 用例 1：标准教科书起坡，每排 C 应恰好 ≈ cGood ----------
const s = { ...DEFAULTS.settings };
let rows = [];
for (let i = 0; i < 8; i++) rows.push({ type: "seat", depth: 0.9, elev: 0, locked: false });
state = { settings: s, rows };
autoGradient();
let res = compute(s, rows);
console.log("用例1 自动起坡逐排标高：", rows.map(r => r.elev.toFixed(3)).join(", "));
res.list.forEach((r, i) => {
  if (i === 0) return;
  check(`第${i + 1}排 C≈0.12（>=0.119）`, r.c >= 0.119 && r.c <= 0.1205, { c: r.c });
});
check("起坡递增", rows[7].elev > rows[1].elev);

// ---------- 用例 2：平地楼座，后排应报遮挡 ----------
const flat = Array.from({ length: 6 }, () => ({ type: "seat", depth: 0.85, elev: 0, locked: false }));
res = compute(s, flat);
console.log("用例2 平地 C 值：", res.list.map(r => r.c === null ? "首" : r.c.toFixed(3)).join(", "));
check("第2排即 C<0.12", res.list[1].c < s.cGood, { c: res.list[1].c });
check("存在 bad/block 标记", res.counts.bad + res.counts.block > 0, res.counts);
check("遮挡高度 >0（被遮挡排）", res.list.some(r => r.blockedH > 0));
// y0 为舞台前口平面上的遮挡高度，可大于视点高，几何上非负即可
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

// ---------- 用例 6：锁定排不被自动起坡修改 ----------
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
check("第三排相对锁定第2排 C 达标", res.list[2].c >= 0.119, { c: res.list[2].c });

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

// 通道宽度语义：通道 depth 即其占地宽（通道中心=4.5+0.9+0.6=6.0）
const aislePos = [
  { type: "seat", depth: 0.9, elev: 0 },
  { type: "aisle", depth: 1.2, elev: 0 },
];
res = compute({ ...s, firstDistance: 4.5 }, aislePos);
check("通道占地 1.2m：前缘 4.95 / 中心 5.55 / 后缘 6.15",
  Math.abs(res.list[1].x - 5.55) < 1e-9 && Math.abs(res.dxs[1] - 4.95) < 1e-9,
  { x: res.list[1].x, front: res.dxs[1] });

// ---------- 用例 8：手算几何校验 ----------
// V=(0,1.0)，第1排 x=5 眼1.15/头1.30；第2排 x=6 平地。
// yL = 1 + (1.3-1)*6/5 = 1.36；C = 1.15-1.36 = -0.21
const s8 = { ...s, vy: 1.0, firstDistance: 5.0 };
res = compute(s8, [
  { type: "seat", depth: 1.0, elev: 0 },
  { type: "seat", depth: 1.0, elev: 0 },
]);
check("手算 C=-0.21", Math.abs(res.list[1].c - (-0.21)) < 1e-9, { c: res.list[1].c });
check("判定为已遮挡", res.list[1].risk === "block");
// 射线 E2(6,1.15)→H1(5,1.30) 斜率 -0.15，x=0 时 y=2.05
check("遮挡范围 y0=2.05", Math.abs(res.list[1].rayY0 - 2.05) < 1e-9, { y: res.list[1].rayY0 });
check("blockedH=max(0,y0)=2.05", Math.abs(res.list[1].blockedH - 2.05) < 1e-9, { b: res.list[1].blockedH });

console.log("\n结果：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
