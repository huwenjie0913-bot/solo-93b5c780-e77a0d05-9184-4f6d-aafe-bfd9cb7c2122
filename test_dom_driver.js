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

  // ============ 严格阈值界面一致性回归（刻度间边界）============
  // V=(0,1.0)、前排 x=5 头顶1.30、后排 x=6；真实净空 C=1+(eye2−1)·5/6−1.30
  //  → eye2 = 1+(C+0.30)·6/5。楼面标高不取整，精确命中目标真实 C。
  function boundaryState(cVal) {
    const eye2 = 1 + (cVal + 0.30) * 6 / 5;
    state.settings = {
      ...state.settings, vy: 1.0, firstDistance: 5.0,
      eyeHeight: 1.15, headHeight: 1.30, cGood: 0.120, cMin: 0.060,
    };
    state.rows = [
      { type: "seat", depth: 1.0, elev: 0, locked: false },
      { type: "seat", depth: 1.0, elev: eye2 - 1.15, locked: false },
    ];
    renderRows(compute(state.settings, state.rows), true);
    refresh();
    const resNow = compute(state.settings, state.rows);
    return {
      cell: idMap["rows-body"].children[1].querySelector("[data-c]").innerHTML,
      row: resNow.list[1],
      summary: idMap["summary"].innerHTML,
    };
  }

  // 真实 0.119600：毫米舍入是 0.120，但必须显示 0.1196 且判偏差
  let b = boundaryState(0.119600);
  ok("0.119600 真实值保留", Math.abs(b.row.c - 0.1196) < 1e-12, { c: b.row.c });
  ok("界面 0.119600 显示 0.1196（不显示 0.120）",
    b.cell.includes("0.1196") && !b.cell.includes(">0.120<"), b.cell);
  ok("界面 0.119600 徽标 warn/偏差，绝不合格",
    b.cell.includes("badge warn") && b.cell.includes("偏差") && !b.cell.includes("合格"), b.cell);

  // 两位小数输入产生的真实 0.119700：同样显示 0.1197 判偏差
  b = boundaryState(0.119700);
  ok("界面 0.119700 显示 0.1197（不显示 0.120）",
    b.cell.includes("0.1197") && !b.cell.includes(">0.120<"), b.cell);
  ok("界面 0.119700 徽标 warn/偏差",
    b.cell.includes("badge warn") && !b.cell.includes("合格"), b.cell);

  // 真实 0.119（毫米刻度内）显示 0.119 判偏差
  b = boundaryState(0.119);
  ok("界面 0.119 显示 0.119", b.cell.includes("0.119"), b.cell);
  ok("界面 0.119 判偏差", b.cell.includes("badge warn") && !b.cell.includes("合格"), b.cell);

  // 真实达到 0.120000：显示 0.120 且合格
  b = boundaryState(0.120000);
  ok("界面 0.120000 显示 0.120", b.cell.includes(">0.120<"), b.cell);
  ok("界面 0.120000 徽标 good/合格",
    b.cell.includes("badge good") && b.cell.includes("合格") && !b.cell.includes("偏差"), b.cell);
  ok("汇总条与 0.120 状态一致：合格≥1",
    /合格[\s\S]*?<b class="good">\s*[1-9]/.test(b.summary), b.summary);

  // 报告文字：阈值说明严格（含 0.1196/0.1197 示例）。报告基于当前 state，
  // 故在恢复示例前生成一份“0.1196 场景”的报告检查逐排表显示。
  b = boundaryState(0.119600);
  globalThis.__opened.html = null;
  idMap["btn-report"].dispatch("click");
  const rep = globalThis.__opened.html;
  ok("报告：阈值文字含“严格”与 0.119600/0.119700 说明",
    rep.includes("严格") && rep.includes("0.119600") && rep.includes("0.119700"));
  ok("报告逐排表显示 0.1196 且判偏差",
    rep.includes("0.1196") && rep.includes("偏差"));

  // 恢复示例，避免影响后续保存/比较流程
  idMap["btn-reset"].dispatch("click");


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

  // ============ 平面布置 ============
  idMap["btn-reset"].dispatch("click");
  let prNow = currentPlan();
  const occN = state.rows.filter(isOcc).length;
  ok("平面：默认每排 12 座", prNow.totals.seats === occN * 12,
    { seats: prNow.totals.seats, occN });
  ok("平面：台口中线对齐布置存在遮挡座位", prNow.totals.block > 0, prNow.totals);
  ok("平面：汇总条含横向净空", idMap["plan-summary"].innerHTML.includes("横向净空"));

  // 排表座位数输入 → 平面重算
  const seatsEl = idMap["rows-body"].children[0].querySelector('[data-planfield="seats"]');
  seatsEl.value = "10";
  seatsEl.dispatch("input");
  ok("排表改座位数→平面重算", getPlanRowCfg(state.plan, 0).seats === 10 &&
    currentPlan().rows[0].seats.length === 10);

  // 选中排平面编辑器 + 全部沿用
  selected = 2; selectedSeat = -1; refresh();
  idMap["plan-gap"].value = "0.10";
  idMap["plan-gap"].dispatch("input");
  ok("编辑器改横向间距", Math.abs(getPlanRowCfg(state.plan, 2).gap - 0.10) < 1e-9);
  idMap["btn-apply-plan-all"].dispatch("click");
  ok("全部座席排沿用平面参数", state.rows.every((r, i) =>
    !isOcc(r) || Math.abs(getPlanRowCfg(state.plan, i).gap - 0.10) < 1e-9));

  // ============ 过道设置影响遮挡结果（本轮缺陷回归）============
  const snapPlan = (pr) => pr.rows.map((ro) => ro.occupied
    ? ro.seats.map((st) => [st.cx, st.clear, st.blockerRow, st.blockerSeat, st.risk]) : null);
  const snap0 = snapPlan(currentPlan());
  const nSeats2 = currentPlan().rows[2].seats.length;
  idMap["plan-aislel"].value = "3";
  idMap["plan-aislel"].dispatch("input");   // 选中排 R3 左过道 1.10 → 3
  ok("左过道写入配置", Math.abs(getPlanRowCfg(state.plan, 2).aisleL - 3) < 1e-9);
  const snap1 = snapPlan(currentPlan());
  let cxChanged = 0, resChanged = 0;
  snap0.forEach((row0, i) => {
    if (!row0) return;
    row0.forEach((cell0, k) => {
      const cell1 = snap1[i][k];
      if (Math.abs(cell1[0] - cell0[0]) > 1e-9) cxChanged++;
      if (cell0[1] !== cell1[1] || cell0[2] !== cell1[2] ||
          cell0[3] !== cell1[3] || cell0[4] !== cell1[4]) resChanged++;
    });
  });
  ok("过道变更：R3 全部座位 cx 重定位", cxChanged === nSeats2, { cxChanged, nSeats2 });
  ok("过道变更：遮挡者/净空/风险同步重算", resChanged > 0, { resChanged });
  ok("过道变更：排表横向净空列同步", (() => {
    const html = idMap["rows-body"].children[2].querySelector("[data-plan-c]").innerHTML;
    return html.includes("badge");
  })());

  // ============ 平面画布拖拽 ============
  const pcv = idMap["plan-canvas"];
  const pdown = listeners.get(pcv)["pointerdown"];
  const pmove = listeners.get(pcv)["pointermove"];
  const resNow = primaryDataset().res;

  // 拖动右过道把手 → aisleR 增大且座位横移
  const geo2 = currentPlan().rows[2].geo;
  const [gpx, gpy] = planView.P(geo2.blockEnd, resNow.list[2].x);
  const aR0 = getPlanRowCfg(state.plan, 2).aisleR;
  const cxSnap = currentPlan().rows[2].seats.map((st) => st.cx);
  pdown({ clientX: gpx, clientY: gpy, pointerId: 31 });
  pmove({ clientX: gpx + 30, clientY: gpy, pointerId: 31 });
  globalThis.__windowListeners.pointerup();
  const aR1 = getPlanRowCfg(state.plan, 2).aisleR;
  ok("拖动右过道把手→aisleR 增大", aR1 > aR0, { aR0, aR1 });
  ok("过道拖动→座位横向位置同步变化",
    currentPlan().rows[2].seats.some((st, k) => Math.abs(st.cx - cxSnap[k]) > 1e-9));

  // 拖动座位 → 错排偏移
  const st5 = currentPlan().rows[3].seats[5];
  const [spx, spy] = planView.P(st5.cx, resNow.list[3].x);
  const stag0 = getPlanRowCfg(state.plan, 3).stagger;
  pdown({ clientX: spx, clientY: spy, pointerId: 32 });
  pmove({ clientX: spx + 25, clientY: spy, pointerId: 32 });
  globalThis.__windowListeners.pointerup();
  ok("拖动座位→错排偏移增大", getPlanRowCfg(state.plan, 3).stagger > stag0,
    { stag0, stag1: getPlanRowCfg(state.plan, 3).stagger });

  // 点击座位 → 联动选中（排表 + 详情含纵剖面排高与 C 值）
  const st7 = currentPlan().rows[6].seats[7];
  const [cpx, cpy] = planView.P(st7.cx, resNow.list[6].x);
  pdown({ clientX: cpx, clientY: cpy, pointerId: 33 });
  globalThis.__windowListeners.pointerup();
  ok("点击座位：选中排与座号", selected === 6 && selectedSeat === 7,
    { selected, selectedSeat });
  ok("点击座位：排表选中行同步", idMap["rows-body"].children[6].classList.contains("selected"));
  const det = idMap["plan-detail"].innerHTML;
  ok("详情：遮挡者+净空+纵剖面 C 值联动",
    det.includes("遮挡者") && det.includes("C 值") && det.includes("楼面标高"), det);

  // 目标点切换 / 最不利方向 / 拖动目标点
  const swBox = idMap["plan-target-switch"];
  ok("目标点切换按钮=3", swBox.children.length === 3);
  swBox.children[2].dispatch("click");
  ok("切换目标点", state.plan.activeTarget === state.plan.targets[2].id);
  idMap["btn-worst-target"].dispatch("click");
  ok("最不利目标点已激活", state.plan.activeTarget === worstTargetId(currentRanking()));
  const tx0 = state.plan.targets[0].x;
  const [tpx, tpy] = planView.P(tx0, 0);
  pdown({ clientX: tpx, clientY: tpy, pointerId: 34 });
  pmove({ clientX: tpx + 40, clientY: tpy, pointerId: 34 });
  globalThis.__windowListeners.pointerup();
  ok("拖动目标点改变 x", state.plan.targets[0].x !== tx0,
    { tx0, tx1: state.plan.targets[0].x });

  // 遮挡热力开关
  idMap["plan-heat"].checked = false;
  idMap["plan-heat"].dispatch("change");
  ok("遮挡热力关闭", planHeat === false);
  idMap["plan-heat"].checked = true;
  idMap["plan-heat"].dispatch("change");
  ok("遮挡热力开启", planHeat === true);

  // 目标点增删
  const nT = state.plan.targets.length;
  idMap["btn-add-target"].dispatch("click");
  ok("添加目标点", state.plan.targets.length === nT + 1);
  const tl = idMap["target-list"];
  tl.children[tl.children.length - 1].querySelector(".del-btn").dispatch("click");
  ok("删除目标点", state.plan.targets.length === nT);

  // 报告：平面布置 + 逐座位明细
  globalThis.__opened.html = null;
  idMap["btn-report"].dispatch("click");
  const repP = globalThis.__opened.html;
  ok("报告含平面布置与逐座位明细",
    repP.includes("平面布置") && repP.includes("逐座位横向视线明细"));
  ok("报告含目标点汇总与过道列", repP.includes("目标点") && repP.includes("左过道"));

  // 保存 / 载入：平面参数与校核结果随布置持久化
  savedId = null;   // 之前的 savedId 已在删除流程中失效，强制另存为新布置
  idMap["layout-name"].value = "平面回归方案";
  idMap["btn-save"].dispatch("click");
  await new Promise((r) => setTimeout(r, 20));
  const savedArr = [...globalThis.__store.values()];
  const savedLast = savedArr[savedArr.length - 1];
  ok("平面参数随布置保存", !!(savedLast.data.plan && savedLast.data.plan.rows &&
    Object.keys(savedLast.data.plan.rows).length > 0));
  ok("校核结果快照随布置保存", !!(savedLast.data.results &&
    savedLast.data.results.plan && savedLast.data.results.section));
  const gapMem = getPlanRowCfg(state.plan, 2).gap;
  const aisleMem = getPlanRowCfg(state.plan, 2).aisleL;
  await loadLayout(savedLast.id);
  ok("载入后平面参数恢复",
    Math.abs(getPlanRowCfg(state.plan, 2).gap - gapMem) < 1e-9 &&
    Math.abs(getPlanRowCfg(state.plan, 2).aisleL - aisleMem) < 1e-9);

  console.log("\n冒烟结果：" + (errors === 0 ? "全部通过" : errors + " 处失败"));
  process.exit(errors ? 1 : 0);
})().catch((e) => { console.error("运行时错误：", e.stack || e); process.exit(1); });
