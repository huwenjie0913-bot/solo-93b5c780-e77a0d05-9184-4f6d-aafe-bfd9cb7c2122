(async function main() {
  let errors = 0;
  const ok = (name, cond) => { console.log((cond ? "  ✓ " : "  ✗ ") + name); if (!cond) errors++; };

  // init() 已随脚本执行；检查排表行已渲染
  ok("排表渲染 9 行（示例）", idMap["rows-body"].children.length === 9);
  ok("汇总条有内容", idMap["summary"].innerHTML.includes("总进深"));

  // 触发一次设置输入（视点高度）
  const vyInput = idMap["set-vy"];
  vyInput.value = "0.8";
  vyInput.dispatch("input");
  ok("改视点高度后刷新无异常", true);

  // 起坡
  idMap["btn-autogradient"].dispatch("click");
  ok("自动起坡执行", state.rows.some((r) => r.elev > 0.3));

  // 追加排
  idMap["btn-add-row"].dispatch("click");
  ok("追加一排→10 行", state.rows.length === 10);

  // 应用排数
  idMap["set-rowcount"].value = "6";
  idMap["btn-apply-rowcount"].dispatch("click");
  ok("应用排数=6", state.rows.length === 6);

  // 全部解锁 / 恢复示例
  idMap["btn-unlock-all"].dispatch("click");
  ok("全部解锁", state.rows.every((r) => !r.locked));
  idMap["btn-reset"].dispatch("click");
  ok("恢复示例 9 行", state.rows.length === 9);

  // 行内输入：第 1 排（通过与应用一致的选择器取缓存元素）
  const tr0 = idMap["rows-body"].children[0];
  const depthEl = tr0.querySelector('[data-field="depth"]');
  depthEl.value = "1.10";
  depthEl.dispatch("input");
  ok("行内改进深生效", Math.abs(state.rows[0].depth - 1.10) < 1e-9);

  // 行内锁定勾选
  const lockEl = tr0.querySelector('[data-field="locked"]');
  lockEl.checked = true;
  lockEl.dispatch("change");
  ok("锁定第1排", state.rows[0].locked === true);

  // 类型改为通道（重建后通道行无锁定）
  const typeEl = tr0.querySelector('[data-field="type"]');
  typeEl.value = "aisle";
  typeEl.dispatch("change");
  ok("第1排改为通道", state.rows[0].type === "aisle");
  ok("通道自动取消锁定", state.rows[0].locked === false);

  // ============ 拖拽回归（缺陷1）============
  idMap["btn-reset"].dispatch("click"); // 恢复示例：0,1 排锁定；2,3 排未锁定
  const cv = idMap["canvas"];
  const down = listeners.get(cv)["pointerdown"];
  const move = listeners.get(cv)["pointermove"];
  const up = globalThis.__windowListeners && globalThis.__windowListeners.pointerup;

  // --- 视点：纵横独立 ---
  let vpXY = view.P(0, state.settings.vy);
  const vyV0 = state.settings.vy;
  down({ clientX: vpXY[0], clientY: vpXY[1], pointerId: 11 });
  move({ clientX: vpXY[0], clientY: vpXY[1] - 30, pointerId: 11 }); // 纯上拖
  ok("视点纵拖：高度增加", state.settings.vy > vyV0, { vy: state.settings.vy });
  ok("视点纵拖：首排距离不变", Math.abs(state.settings.firstDistance - 4.5) < 1e-9,
    { fd: state.settings.firstDistance });

  // --- 锁定排（示例第2排 index=1）不可拖 ---
  idMap["btn-reset"].dispatch("click");
  const lockRow = primaryDataset().res.list[1];
  const [lx, ly] = view.P(lockRow.x, lockRow.eyeY);
  const depthBefore = state.rows[1].depth, elevBefore = state.rows[1].elev;
  down({ clientX: lx, clientY: ly, pointerId: 12 });
  move({ clientX: lx + 40, clientY: ly - 60, pointerId: 12 });
  ok("锁定排不响应拖拽（进深/标高不变）",
    state.rows[1].depth === depthBefore && state.rows[1].elev === elevBefore,
    { d: state.rows[1].depth, e: state.rows[1].elev });

  // --- 未锁定排（index=2）：1 像素横拖不得跳到 0.45 边界，且连续 ---
  const row2 = primaryDataset().res.list[2];
  const d0 = state.rows[2].depth, e0 = state.rows[2].elev, fd0 = state.settings.firstDistance;
  const [hx, hy] = view.P(row2.x, row2.eyeY);
  down({ clientX: hx, clientY: hy, pointerId: 13 });
  move({ clientX: hx + 1, clientY: hy, pointerId: 13 });
  const d1 = state.rows[2].depth;
  ok("横拖 1px 进深不跳到 0.45（仍接近原值）",
    Math.abs(d1 - d0) < 0.05 && d1 > 0.45, { d0, d1 });
  ok("横拖 1px 标高不变（轴向独立）", Math.abs(state.rows[2].elev - e0) < 1e-9,
    { e0, e: state.rows[2].elev });
  ok("横拖非首排不改首排距离", Math.abs(state.settings.firstDistance - fd0) < 1e-9);

  // 继续横拖 20px：δD = 2·δx，连续且受 [0.45,3] 约束
  move({ clientX: hx + 20, clientY: hy, pointerId: 13 });
  const d20 = state.rows[2].depth;
  const world20 = 20 / view.sc;
  ok("横拖 20px：δD≈2·δx（中点模型）",
    Math.abs(d20 - d0 - 2 * world20) < 0.02, { d20, d0, expect: d0 + 2 * world20 });
  ok("横拖 20px 标高仍不变", Math.abs(state.rows[2].elev - e0) < 1e-9);
  ok("进深不越上界", state.rows[2].depth <= 3.0 + 1e-9);

  // --- 大幅横拖到负方向，进深被夹在 0.45 下界 ---
  move({ clientX: hx - 400, clientY: hy, pointerId: 13 });
  ok("进深夹到下界 0.45", Math.abs(state.rows[2].depth - 0.45) < 1e-9,
    { d: state.rows[2].depth });

  // --- 纯纵拖（从进深已贴下界的状态开始）：只改标高，进深保持 0.45 ---
  const dBeforeV = state.rows[2].depth, eBeforeV = state.rows[2].elev;
  move({ clientX: hx - 400, clientY: hy - 30, pointerId: 13 });
  ok("纯纵拖抬高标高", state.rows[2].elev > eBeforeV, { e0: eBeforeV, e: state.rows[2].elev });
  ok("纯纵拖进深不变", Math.abs(state.rows[2].depth - dBeforeV) < 1e-9,
    { dBeforeV, d: state.rows[2].depth });

  // --- 首排横拖改首排距离（先解锁首排，并用解锁后视图坐标）---
  idMap["btn-reset"].dispatch("click");
  state.rows[0].locked = false;
  refresh();
  const row0 = primaryDataset().res.list[0];
  const [f0x, f0y] = view.P(row0.x, row0.eyeY);
  const fdA = state.settings.firstDistance;
  down({ clientX: f0x, clientY: f0y, pointerId: 14 });
  move({ clientX: f0x + 30, clientY: f0y, pointerId: 14 });
  ok("首排横拖改首排距离（1:1）",
    Math.abs(state.settings.firstDistance - (fdA + 30 / view.sc)) < 0.02,
    { fd: state.settings.firstDistance, expect: fdA + 30 / view.sc });
  ok("首排横拖首排标高不变", Math.abs(state.rows[0].elev - 0) < 1e-9);
  idMap["btn-reset"].dispatch("click");

  // 空处按下/移动不报错
  down({ clientX: 4, clientY: 4, pointerId: 15 });
  move({ clientX: 5, clientY: 5, pointerId: 15 });
  ok("空处无命中不报错", true);


  // 保存布置
  idMap["layout-name"].value = "冒烟方案A";
  idMap["layout-note"].value = "备注内容";
  idMap["btn-save"].dispatch("click");
  await new Promise((r) => setTimeout(r, 20));
  ok("保存后服务器有 1 套", globalThis.__store.size === 1);

  // 同名再保存：按应用设计为更新同一套（PUT）
  idMap["layout-name"].value = "冒烟方案A-改";
  idMap["btn-save"].dispatch("click");
  await new Promise((r) => setTimeout(r, 20));
  ok("改名保存仍为同一套（更新）", globalThis.__store.size === 1);

  // 直接再建第二套，用于比较
  await api("/api/layouts", { method: "POST",
    body: JSON.stringify({ name: "冒烟方案B", data: { settings: state.settings, rows: state.rows } }) });
  await refreshLayouts();

  // 载入第一套
  const ids = [...globalThis.__store.keys()];
  const firstId = ids[0];
  await loadLayout(firstId);
  ok("载入布置名称回填", state.name.includes("冒烟方案A"));

  // 叠加比较
  compareIds = [...globalThis.__store.keys()];
  renderComparePicker();
  refresh();
  idMap["btn-compare"].dispatch("click");
  ok("比较模态已打开", !idMap["compare-modal"].classList.contains("hidden"));
  idMap["btn-compare-print"].dispatch("click");
  ok("比较报告 HTML 已生成", !!globalThis.__opened.html && globalThis.__opened.html.includes("多方案"));
  idMap["btn-close-compare"].dispatch("click");
  ok("比较模态已关闭", idMap["compare-modal"].classList.contains("hidden"));

  // 单方案打印报告
  globalThis.__opened.html = null;
  idMap["btn-report"].dispatch("click");
  ok("打印报告已生成（参数/逐排/依据/示意图）",
    globalThis.__opened && globalThis.__opened.html.includes("观众席视线校核报告") &&
    globalThis.__opened.html.includes("逐排计算结果") &&
    globalThis.__opened.html.includes("计算依据") &&
    globalThis.__opened.html.includes("data:image/png"));

  // 清除叠加
  idMap["btn-clear-compare"].dispatch("click");
  ok("叠加已清除", compareIds.length === 0);

  // 删除一套（调 API）并刷新列表
  await api("/api/layouts/" + firstId, { method: "DELETE" });
  await refreshLayouts();
  ok("删除后剩 1 套", globalThis.__store.size === 1);

  console.log("\n冒烟结果：" + (errors === 0 ? "全部通过" : errors + " 处失败"));
  process.exit(errors ? 1 : 0);
})().catch((e) => { console.error("运行时错误：", e.stack || e); process.exit(1); });
