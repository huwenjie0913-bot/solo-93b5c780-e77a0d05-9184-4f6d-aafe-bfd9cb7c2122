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

  // Canvas 指针：拖拽视点（用实际控制点屏幕坐标）
  const cv = idMap["canvas"];
  const down = listeners.get(cv)["pointerdown"];
  const move = listeners.get(cv)["pointermove"];
  const vpXY = view.P(0, state.settings.vy);
  const vy0 = state.settings.vy, fd0 = state.settings.firstDistance;
  down({ clientX: vpXY[0], clientY: vpXY[1], pointerId: 1 });
  move({ clientX: vpXY[0] + 30, clientY: vpXY[1] + 60, pointerId: 1 });
  ok("视点拖拽改变参数", state.settings.vy !== vy0 || state.settings.firstDistance !== fd0);

  // 拖第 2 排眼位（先恢复数据）
  idMap["btn-reset"].dispatch("click");
  // 命中点用 view.P 计算世界坐标后反推屏幕坐标
  const ds0 = primaryDataset();
  const vNow = view;
  const [ex, ey] = vNow.P(ds0.res.list[1].x, ds0.res.list[1].eyeY);
  down({ clientX: ex, clientY: ey, pointerId: 2 });
  move({ clientX: ex + 10, clientY: ey - 40, pointerId: 2 });
  ok("拖排眼位抬高第2排", state.rows[1].elev > 0 || state.rows[1].depth !== 0.85);

  // 空处点击不选中
  move({ clientX: 5, clientY: 5, pointerId: 3 });
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
