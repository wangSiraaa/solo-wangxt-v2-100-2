// 工况集验收端到端：
//  1) 同一速度公式在“常温/满载”切换，结果与 km/h 换算各自正确；
//  2) 修改公共质量 m：未覆盖工况更新、覆盖工况保持原值；
//  3) 两个标签页（用测试钩子模拟）改不同字段自动合并、改同一字段弹冲突且双方历史都在；
//  4) 旧版（无工况）JSON 导入生成可追溯默认工况；删除/恢复工况、刷新后旧快照与独立公式仍可用。
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const URL = "http://localhost:5199/";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

async function freshPage() {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.deleteDatabase("dimension-notebook");
    req.onsuccess = () => res();
    req.onblocked = () => res();
    req.onerror = () => res();
  }));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".conditions-bar");
}

const condTab = (name) => page.locator(".cond-tab", { hasText: name }).first();
const activeTab = () => page.locator(".cond-tab.active");

async function newCondition(name) {
  await page.locator(".cond-new-input").fill(name);
  await page.getByRole("button", { name: "＋ 新建工况" }).click();
  await page.waitForTimeout(150);
}

async function openDefaults() {
  if (await page.locator(".defaults-body").count() === 0) {
    await page.getByRole("button", { name: /公共默认变量/ }).click();
    await page.waitForSelector(".defaults-body");
  }
}

/** 在公共默认表格里设置某变量行（变量必须已存在于默认表） */
async function setDefaultRow(name, value, unit) {
  const row = page.locator(".defaults-body .var-row").filter({
    has: page.locator(".var-name", { hasText: new RegExp(`^${name}$`) }),
  }).first();
  await row.locator(".num-input").fill(value);
  await row.locator(".unit-input").fill(unit);
}

async function addDefaultVar(name) {
  const add = page.locator(".defaults-add input");
  await add.fill(name);
  await page.locator(".defaults-add button", { hasText: "添加默认变量" }).click();
}

/** 当前激活卡片中某变量行（按变量名单元格精确匹配，避免 m 匹配到 m/s） */
function varRow(card, name) {
  return card.locator(".var-row:not(.var-head)").filter({
    has: page.locator(".var-name", { hasText: new RegExp(`^${name}$`) }),
  }).first();
}

async function cardResult(i) {
  const card = page.locator(".card").nth(i);
  return (await card.locator(".result-row .tex-box").innerText().catch(() => "")).replace(/\s+/g, " ");
}

async function flush(ms = 500) {
  await page.evaluate((ms) => window.__dnTest.flush(ms), ms);
}

// ============ 验收 1：速度公式常温/满载切换 + km/h 换算 ============
await freshPage();
await page.getByRole("button", { name: "示例：速度 s/t" }).click();
await page.waitForTimeout(200);
await openDefaults();
await addDefaultVar("s");
await addDefaultVar("t");
await setDefaultRow("s", "100", "m");
await setDefaultRow("t", "10", "s");
await flush();

// 常温工况（默认）：100 m / 10 s = 10 m/s = 36 km/h
let resultText = await cardResult(0);
check("常温：100 m/10 s = 36 km/h", /36\s*km/.test(resultText), resultText);

// 新建“满载”，仅覆盖 s = 36 km，t 继承默认 10 s → 3600 m/s = 12960 km/h
await newCondition("满载");
const card0 = page.locator(".card").nth(0);
// 继承行只读，点击“覆盖”后再填
await varRow(card0, "s").getByRole("button", { name: "覆盖" }).click();
await varRow(card0, "s").locator(".num-input").fill("36");
await varRow(card0, "s").locator(".unit-input").fill("km");
await flush();
resultText = await cardResult(0);
check("满载：36 km/10 s = 12960 km/h（时间继承默认）", /12960/.test(resultText), resultText);
// t 行应显示“继承默认”
const tBadge = await varRow(card0, "t").locator(".src-badge").innerText();
check("满载工况下 t 显示继承默认", tBadge.includes("继承默认"), tBadge);
const sBadge = await varRow(card0, "s").locator(".src-badge").innerText();
check("满载工况下 s 显示覆盖", sBadge.includes("覆盖"), sBadge);

// 切回常温，结果回到 36 km/h
await condTab("默认工况").locator(".cond-tab-btn").click();
await page.waitForTimeout(200);
resultText = await cardResult(0);
check("切回常温：结果恢复 36 km/h", /36\s*km/.test(resultText), resultText);

// ============ 验收 2：公共质量更新，未覆盖更新/覆盖保持 ============
// 先建一条只有质量变量的公式，并在公共默认设 m = 100 kg
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(150);
const massCard = page.locator(".card").nth(1);
await massCard.locator("math-field").evaluate((el, v) => {
  el.setValue(v); el.dispatchEvent(new Event("input", { bubbles: true }));
}, "m");
await page.waitForTimeout(200);
await openDefaults();
await addDefaultVar("m");
await setDefaultRow("m", "100", "kg");
await flush();

// 新建“故障”工况：m 继承默认 100，点击“覆盖”后改为 999 kg
await newCondition("故障");
await varRow(massCard, "m").getByRole("button", { name: "覆盖" }).click();
await varRow(massCard, "m").locator(".num-input").fill("999");
await varRow(massCard, "m").locator(".unit-input").fill("kg");
await flush();
// 公共质量改成 120 kg
await setDefaultRow("m", "120", "kg");
await flush();
// 故障工况 m 仍 999（覆盖保持原值）
let mVal = await varRow(massCard, "m").locator(".num-input").inputValue();
check("故障工况覆盖质量保持 999", mVal === "999", mVal);
const mBadge = await varRow(massCard, "m").locator(".src-badge").innerText();
check("故障工况 m 标记为覆盖", mBadge.includes("覆盖"), mBadge);
// 切回默认工况（未覆盖），m 跟随公共默认 120
await condTab("默认工况").locator(".cond-tab-btn").click();
await page.waitForTimeout(200);
mVal = await varRow(massCard, "m").locator(".num-input").inputValue();
check("默认工况未覆盖质量随公共默认变为 120", mVal === "120", mVal);

// 量纲不兼容覆盖：默认 m 是 kg，在某工况把 m 的单位改成 m（长度）应被明确拒绝
await newCondition("量纲错误工况");
await flush(350); // 等新建工况落库，避免后续编辑基于旧修订号
await varRow(massCard, "m").getByRole("button", { name: "覆盖" }).click();
await flush(350); // 覆盖种子值先落库
await varRow(massCard, "m").locator(".unit-input").fill("m");
await flush(500);
const rejectNotice = await page.locator(".notice").innerText().then((t) => t.includes("量纲不兼容")).catch(() => false);
check("单位量纲不兼容的覆盖被明确拒绝（不静默写入）", rejectNotice, await page.locator(".notice").innerText().catch(() => ""));
// 该工况落库的 m 单位绝不能是 m（长度），不能污染其他工况
await flush(300);
const rejectRow = await page.evaluate(() => window.__dnTest.getRemote()).then((nb) =>
  nb.conditions.find((c) => c.name === "量纲错误工况"));
check("拒绝后该工况落库单位仍为 kg（未被污染）", rejectRow.overrides.m?.unit === "kg", JSON.stringify(rejectRow.overrides.m));
// 回到默认工况继续后续用例
await condTab("默认工况").locator(".cond-tab-btn").click();
await page.waitForTimeout(200);

// ============ 验收 3：多标签页修订冲突（不同字段合并 / 同字段冲突） ============
await freshPage();
await openDefaults();
await addDefaultVar("m");
await addDefaultVar("v");
await setDefaultRow("m", "10", "kg");
await setDefaultRow("v", "1", "m/s");
await flush();
// 当前“默认工况”本地先覆盖 m = 20（模拟标签页 A 的待保存编辑）
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(150);
const c3 = page.locator(".card").nth(0);
await c3.locator("math-field").evaluate((el, x) => {
  el.setValue(x); el.dispatchEvent(new Event("input", { bubbles: true }));
}, "m+v");
await page.waitForTimeout(200);
await varRow(c3, "m").getByRole("button", { name: "覆盖" }).click();
await varRow(c3, "m").locator(".num-input").fill("20");
await flush();

// 3a) 本标签页对 m 的修改尚在待保存时，另一标签页保存了不同字段 v → 自动字段级合并
const remoteBefore = await page.evaluate(() => window.__dnTest.getRemote());
await varRow(c3, "m").locator(".num-input").fill("25");
await page.evaluate(({ condId }) => window.__dnTest.remoteSaveCondition(condId, { v: { value: "7", unit: "m/s" } }), { condId: remoteBefore.activeConditionId });
await flush(700);
const hasAutoMergeNotice = await page.locator(".notice").innerText().then((t) => t.includes("字段级合并")).catch(() => false);
check("不同字段：自动字段级合并（m=25 本地，v=7 远端）", hasAutoMergeNotice, await page.locator(".notice").innerText().catch(() => ""));
const mergedM = await varRow(c3, "m").locator(".num-input").inputValue().catch(() => "");
const mergedV = await varRow(c3, "v").locator(".num-input").inputValue().catch(() => "");
check("合并后本地 m=25 保留", mergedM === "25", mergedM);
check("合并后远端 v=7 已合入", mergedV === "7", mergedV);

// 3b) 同一字段双方都改成不同值 → 弹冲突对话框，双方历史都可见，不静默覆盖
await freshPage();
await openDefaults();
await addDefaultVar("x");
await setDefaultRow("x", "1", "m");
await flush();
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(150);
const c3b = page.locator(".card").nth(0);
await c3b.locator("math-field").evaluate((el, x) => {
  el.setValue(x); el.dispatchEvent(new Event("input", { bubbles: true }));
}, "x");
await page.waitForTimeout(200);
await varRow(c3b, "x").getByRole("button", { name: "覆盖" }).click();
await varRow(c3b, "x").locator(".num-input").fill("111");
await flush();
const remote2 = await page.evaluate(() => window.__dnTest.getRemote());
// 本标签页先把 x 改为 333（待保存），随后另一标签页保存 x=222 → 同字段冲突
await varRow(c3b, "x").locator(".num-input").fill("333");
await page.evaluate(({ cid }) => window.__dnTest.remoteSaveCondition(cid, { x: { value: "222", unit: "m" } }), { cid: remote2.activeConditionId });
await flush(700);
const modal = page.locator(".conflict-modal");
await modal.waitFor({ timeout: 3000 }).catch(() => {});
check("同一字段双方修改：弹出修订冲突对话框", await modal.count() > 0);
if (await modal.count() > 0) {
  const body = await modal.innerText();
  check("冲突框保留本标签页值 333", body.includes("333"), "");
  check("冲突框保留另一标签页值 222", body.includes("222"), "");
  check("冲突框明确不会静默覆盖", body.includes("不会静默覆盖"), "");
  // 选择“用另一标签页”
  await modal.locator("text=用另一标签页").first().click();
  await page.getByRole("button", { name: "按上述选择合并并保存" }).click();
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => window.__dnTest.getRemote());
  const ov = saved.conditions.find((c) => c.id === remote2.activeConditionId).overrides.x;
  check("人工选择另一标签页后保存为 222（双方历史在对话框均可见）", ov.value === "222", JSON.stringify(ov));
}

// ============ 验收 4：旧版导入迁移 + 删除/恢复 + 刷新后快照/独立公式 ============
// 构造 v1（无工况）JSON
const v1 = {
  app: "dimension-notebook", version: 1, exportedAt: new Date().toISOString(),
  formulas: [{
    id: "legacy_f1", latex: "s/t", note: "旧公式",
    variables: { s: { value: "100", unit: "m" }, t: { value: "10", unit: "s" } },
    targetUnit: "km/h", createdAt: Date.now(),
  }],
};
await freshPage();
await page.evaluate((json) => {
  const blob = new Blob([json], { type: "application/json" });
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "v1.json", { type: "application/json" }));
  const input = document.querySelector('input[type="file"]');
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}, JSON.stringify(v1));
await page.waitForTimeout(800);
const legacyTab = page.locator(".cond-tab", { hasText: "旧笔记迁移" });
check("旧版导入：生成可追溯“旧笔记迁移”工况", await legacyTab.count() > 0);
const res4 = await cardResult(0);
check("迁移工况下旧公式可计算 = 36 km/h", /36\s*km/.test(res4), res4);
// 等待快照落库
await flush(1200);
const snapBefore = await page.locator(".snap-item").count();
check("产生至少一条旧计算快照（含工况与 rev）", snapBefore >= 1, `${snapBefore}`);
const snapText0 = await page.locator(".snap-item").first().innerText();
check("快照标注工况名与修订号", snapText0.includes("旧笔记迁移") && /rev\s*\d+/.test(snapText0), snapText0.replace(/\s+/g, " ").slice(0, 120));

// 删除当前工况（软删除）：公式不取零、提示删除
await page.locator(".cond-tab.active .mini-btn.danger").click();
await page.waitForTimeout(500);
const errBanner = await page.locator(".card .issue.error").count();
check("删除当前工况后公式提示不可用、不回退零值", errBanner >= 1);
const badgeAfterDelete = (await page.locator(".card .badge").innerText()).trim();
check("删除后状态不是已验证（无零值结果）", badgeAfterDelete !== "已验证", badgeAfterDelete);
// 旧快照仍在
const snapAfterDelete = await page.locator(".snap-item").count();
check("删除工况后旧计算快照仍保留可查看", snapAfterDelete >= 1, `${snapAfterDelete}`);

// 显示已删除并恢复
await page.getByRole("button", { name: /显示已删除/ }).click();
await page.waitForTimeout(150);
await page.locator(".cond-tab.deleted").getByRole("button", { name: "恢复" }).first().click();
await page.waitForTimeout(600);
const resRestored = await cardResult(0);
check("恢复工况后公式重新可计算 = 36 km/h", /36\s*km/.test(resRestored), resRestored);

// 刷新页面：工况、公式、快照都还在
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".conditions-bar");
await page.waitForTimeout(600);
const legacyTab2 = page.locator(".cond-tab", { hasText: "旧笔记迁移" });
check("刷新后迁移工况仍在", await legacyTab2.count() > 0);
const cardsAfterReload = await page.locator(".card").count();
check("刷新后独立公式仍在", cardsAfterReload >= 1, `${cardsAfterReload}`);
const snapAfterReload = await page.locator(".snap-item").count();
check("刷新后旧计算快照仍在", snapAfterReload >= 1, `${snapAfterReload}`);
const resAfterReload = await cardResult(0);
check("刷新后结果仍为 36 km/h", /36\s*km/.test(resAfterReload), resAfterReload);

// 导出 v2 含工况与快照，再导入仍然完整
{
  const exported = await page.evaluate(async () => {
    // 直接读取当前 IndexedDB 数据，用页面内 buildExport 不易触达，改为点击导出并拦截
    return null;
  });
  void exported;
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) console.log("浏览器控制台错误：", JSON.stringify(consoleErrors.slice(0, 8), null, 1));
await browser.close();
if (failed.length) process.exit(1);
