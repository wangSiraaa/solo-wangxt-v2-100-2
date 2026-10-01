// 端到端冒烟（v2：参数工况集）
// 覆盖：
//  A. 原有 5 个示例公式的状态徽章/量纲定位/隔离
//  B. 验收1：速度公式在“常温/满载”工况间切换，结果与目标单位换算
//  C. 验收2：改公共默认（质量）后未覆盖工况联动、覆盖工况保持
//  D. 验收3：两个标签页改不同字段自动合并；改同一字段提示冲突、逐字段选择、历史不丢
//  E. 验收4：导入 v1 旧笔记本生成可追溯默认工况；删除/恢复工况、刷新后快照与公式可用
import { chromium } from "playwright";

const URL = "http://localhost:5199/";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  const tail = detail ? `  — ${detail}` : "";
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${tail}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/home/node/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome",
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
const consoleErrors = [];
const page = await context.newPage();
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".app");
await page.waitForTimeout(400);

// ---------- A. 原有示例 ----------
for (const kind of ["unit", "degC", "angle", "dimErr", "divZero"]) {
  await page.getByRole("button", { name: `示例：${{
    unit: "单位运算", degC: "摄氏温标", angle: "角度弧度", dimErr: "量纲错误", divZero: "除零",
  }[kind]}` }).click();
  await page.waitForTimeout(120);
}
await page.waitForTimeout(700);

let cards = page.locator(".card");
await cards.last().waitFor();
check("创建了 5 张公式卡片", await cards.count() === 5, `实际 ${await cards.count()}`);

async function cardInfo(i) {
  const card = cards.nth(i);
  return {
    badge: (await card.locator(".badge").innerText()).trim(),
    summary: (await card.locator(".summary").innerText()).trim(),
    issues: await card.locator(".issue").allInnerTexts(),
    resultText: (await card.locator(".result-row .tex-box").innerText().catch(() => "")).trim(),
    hasRedTex: (await card.locator(".display-area").innerHTML()).includes("#d11f2d"),
    hasOrangeTex: (await card.locator(".display-area").innerHTML()).includes("#b26a00"),
  };
}

const c1 = await cardInfo(0);
check("单位运算：已验证", c1.badge === "已验证", c1.badge);
check("单位运算：结果 24 m", /24/.test(c1.resultText), c1.resultText);
const c2 = await cardInfo(1);
check("摄氏温标：标记未验证", c2.badge === "未验证", c2.badge);
check("摄氏温标：提示偏移温标", c2.issues.some((t) => t.includes("偏移温标")), c2.issues[0] ?? "");
const c3 = await cardInfo(2);
check("角度弧度：已验证", c3.badge === "已验证", c3.badge);
const c4 = await cardInfo(3);
check("量纲错误：有错误", c4.badge === "有错误", c4.badge);
check("量纲错误：红色高亮", c4.hasRedTex);
const c5 = await cardInfo(4);
check("除零：有错误", c5.badge === "有错误", c5.badge);
check("除零：报除数为零", c5.issues.some((t) => t.includes("除数为零")), c5.issues[0] ?? "");

// 删除量纲错误卡片后其余不受影响
await page.getByRole("button", { name: "删除" }).nth(3).click();
await page.waitForTimeout(500);
cards = page.locator(".card");
check("删除后剩余 4 张", await cards.count() === 4);
check("隔离：好公式仍已验证", (await cards.nth(0).locator(".badge").innerText()).trim() === "已验证");

// ---------- B. 验收1：速度公式 + 常温/满载切换 ----------
await page.getByRole("button", { name: "示例：速度/工况切换" }).click();
await page.waitForTimeout(800); // 等防抖保存与“满载”工况创建
cards = page.locator(".card");
const speedCard = cards.last();
await speedCard.waitFor();

// 默认应选中刚创建的“满载”；先切回“常温”
await page.locator(".scn-tab", { hasText: "常温" }).click();
await page.waitForTimeout(400);
let speedText = (await speedCard.locator(".result-row .tex-box").innerText()).trim();
check("常温工况：100 m / 10 s = 10 m/s", /10/.test(speedText), speedText);
check("常温工况：目标单位换算 36 km/h", /36/.test(speedText), speedText);
check("常温卡片显示工况与修订号", /常温/.test((await speedCard.locator(".card-scn").innerText())));

// 切到满载：s=36 km, t=1 h → 36 km/h
await page.locator(".scn-tab", { hasText: "满载" }).click();
await page.waitForTimeout(400);
speedText = (await speedCard.locator(".result-row .tex-box").innerText()).trim();
check("满载工况：36 km/h（原始与换算都约 36）", (speedText.match(/36/g) || []).length >= 1, speedText);
// 满载不应出现 10 m/s
check("满载工况：不使用常温的 10 m/s 原值", !/= 10(?!\d)/.test(speedText.replace(/\s+/g, " ")), speedText);
// 覆盖标记可见
check("满载变量行存在“覆盖”标记", await speedCard.locator(".src-override").count() >= 1);

// 切回常温仍然 36 km/h
await page.locator(".scn-tab", { hasText: "常温" }).click();
await page.waitForTimeout(400);
speedText = (await speedCard.locator(".result-row .tex-box").innerText().catch(() => "")).trim();
check("切回常温仍是 36 km/h", /36/.test(speedText), speedText);

// 继承/覆盖可见性
check("常温 s 行显示继承标记", await speedCard.locator(".src-default").count() >= 2);

// ---------- C. 验收2：公共默认质量联动 ----------
// 新建一条公式 m（质量），公共默认 m 不存在；在默认编辑器加 m=10 kg，再建一个“故障”工况覆盖 m=999 kg
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(300);
cards = page.locator(".card");
const massCard = cards.last();
await massCard.locator("math-field").evaluate((el, v) => {
  el.setValue(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, "m");
await page.waitForTimeout(300);
// 打开公共默认面板，加 m=10 kg
await page.locator(".defaults-panel .defaults-head").click();
await page.locator(".defaults-add .d-name").fill("m");
await page.locator(".defaults-add .d-value").fill("10");
await page.locator(".defaults-add .d-unit").fill("kg");
await page.locator(".defaults-add button").click();
await page.waitForTimeout(700);
// 当前是常温：m 应 = 10 kg
let massText = (await massCard.locator(".result-row .tex-box").innerText()).trim();
check("常温质量继承公共默认 10 kg", /10/.test(massText), massText);

// 建故障工况，覆盖 m=999 kg
await page.getByRole("button", { name: "＋ 新工况" }).click();
await page.waitForTimeout(200);
await page.locator(".scn-rename input").fill("故障");
await page.getByRole("button", { name: "创建" }).click();
await page.waitForTimeout(600);
// 在故障工况变量表中给 m 数值覆盖 999
const mRows = massCard.locator(".var-row:not(.var-head)");
await mRows.first().locator("input").nth(0).fill("999");
await page.waitForTimeout(700);
massText = (await massCard.locator(".result-row .tex-box").innerText()).trim();
check("故障工况覆盖质量 999 kg", /999/.test(massText), massText);

// 回常温；改公共默认 m=25 kg
await page.locator(".scn-tab", { hasText: "常温" }).click();
await page.waitForTimeout(300);
const defRows = page.locator(".defaults-panel .var-row:not(.var-head)");
await defRows.filter({ hasText: "m" }).locator("input").nth(0).fill("25");
await page.waitForTimeout(700);
massText = (await massCard.locator(".result-row .tex-box").innerText()).trim();
check("公共质量改为 25 后，常温（未覆盖）联动为 25", /25/.test(massText), massText);

// 切故障，确认仍是 999
await page.locator(".scn-tab", { hasText: "故障" }).click();
await page.waitForTimeout(300);
massText = (await massCard.locator(".result-row .tex-box").innerText()).trim();
check("故障工况（已覆盖）质量保持 999", /999/.test(massText), massText);

// ---------- 快照：刷新与工况删除后仍可用 ----------
await page.locator(".scn-tab", { hasText: "满载" }).click();
await page.waitForTimeout(300);
await speedCard.locator("button[title^='把当前工况']").click();
await page.waitForTimeout(400);
// 展开历史记录
await page.locator(".snapshot-panel .defaults-head").click();
await page.waitForTimeout(200);
check("生成 1 条历史快照", await page.locator(".snapshot-card").count() >= 1);
const snap = page.locator(".snapshot-card").first();
check("快照记录工况名“满载”与修订号", (await snap.innerText()).includes("满载") && /r\d+/.test(await snap.innerText()));
check("快照记录公共默认修订号", (await snap.innerText()).includes("公共默认修订"));
// 展开变量来源
await snap.locator("summary").click();
check("快照含变量来源表", await snap.locator(".snap-var-table tr").count() >= 1);

// 删除满载工况（软删除）
await page.locator(".scn-tab", { hasText: "满载" }).click();
await page.waitForTimeout(200);
page.once("dialog", (d) => d.accept());
await page.getByRole("button", { name: "删除工况" }).click();
await page.waitForTimeout(500);
check("满载工况已从标签条移除", await page.locator(".scn-tab", { hasText: "满载" }).count() === 0);
check("回收站出现满载", (await page.locator(".trash-panel").innerText()).includes("满载"));
check("快招标注工况已删除", (await snap.innerText()).includes("该工况已删除"));

// 恢复满载
await page.locator(".trash-panel button", { hasText: "恢复" }).click();
await page.waitForTimeout(500);
check("恢复后满载工况回到标签条", await page.locator(".scn-tab", { hasText: "满载" }).count() === 1);
check("恢复后快照重新关联（不再标注缺失）", !(await snap.innerText()).includes("该工况已删除"));

// 刷新页面：快照、公式、工况都在
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
check("刷新后公式仍在", await page.locator(".card").count() >= 5);
check("刷新后三个工况仍在（常温/满载/故障）",
  await page.locator(".scn-tab", { hasText: "常温" }).count() === 1 &&
  await page.locator(".scn-tab", { hasText: "满载" }).count() === 1 &&
  await page.locator(".scn-tab", { hasText: "故障" }).count() === 1);
await page.locator(".snapshot-panel .defaults-head").click();
await page.waitForTimeout(200);
check("刷新后历史快照仍在且冻结", await page.locator(".snapshot-card").count() >= 1);

// ---------- D. 多标签页：不同字段自动合并 / 同字段冲突 ----------
// 用新上下文做隔离测试更干净，但这里直接开第二个真实标签页共享 IDB
const page2 = await context.newPage();
page2.on("pageerror", (e) => consoleErrors.push("P2:" + String(e)));
await page2.goto(URL, { waitUntil: "networkidle" });
await page2.waitForTimeout(800);

// 在 page2（新标签页）改 T 的单位；page1 改 S 的数值——不同字段应自动合并
// 先让两边都选中常温
await page.locator(".scn-tab", { hasText: "常温" }).click();
await page2.locator(".scn-tab", { hasText: "常温" }).click();
await page.waitForTimeout(300);

const speedRow = (pg, name) =>
  pg.locator("main .card[data-note='速度 = 路程/时间：常温/满载切换看单位换算']").first()
    .locator(".var-row").filter({ has: pg.locator(".var-name", { hasText: name }) });

// page2 改速度卡 T 单位为 min（不同字段：T.unit）
await speedRow(page2, "T").locator("input").nth(1).fill("min");
await page2.waitForTimeout(700); // page2 先保存 → rev+1

// page1 改 S 数值（不同字段：S.value）
await speedRow(page, "S").locator("input").nth(0).fill("600");
await page2.waitForTimeout(900); // 等跨标签通知 + CAS

await page.waitForTimeout(500);
// 展开冲突面板（不应有未解决冲突）
await page.locator(".conflict-panel .defaults-head").click();
await page.waitForTimeout(200);
const panelText = await page.locator(".conflict-panel").innerText();
check("不同字段：自动合并，无未解决冲突", !panelText.includes("同字段修订冲突"), panelText.slice(0, 80));
// 两边值都在：刷新 page1 看
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
const mergedSText = await speedRow(page, "S").locator("input").nth(0).inputValue();
const mergedTUnit = await speedRow(page, "T").locator("input").nth(1).inputValue();
check("自动合并保留 page1 改的 S=600", mergedSText === "600", mergedSText);
check("自动合并保留 page2 改的 T 单位 min", mergedTUnit === "min", mergedTUnit);

// ---- 同字段冲突：两页都改常温 S 数值为不同值 ----
// page1 先开始编辑（拿到基于 r(当前) 的草稿），page2 随后改并先保存，
// 再让 page1 的草稿保存——必须被拒绝并给出字段级冲突。
await page2.reload({ waitUntil: "networkidle" });
await page2.waitForTimeout(800);
await page2.locator(".scn-tab", { hasText: "常温" }).click();
await page.locator(".scn-tab", { hasText: "常温" }).click();
await page2.waitForTimeout(200);

// page2 先填 72（其防抖保存约 350ms 后成功）；page1 150ms 后在同一基线上填 88，
// 其保存落在对端提交之后 → CAS 拒绝，冲突卡片出现在 page1。
await speedRow(page2, "S").locator("input").nth(0).fill("72");
await page.waitForTimeout(150);
await speedRow(page, "S").locator("input").nth(0).fill("88");
await page.waitForTimeout(1300);

// page1 应出现冲突面板
await page.locator(".conflict-panel .defaults-head").click();
await page.waitForTimeout(300);
const conflictCard = page.locator(".conflict-card").first();
check("同字段冲突：出现冲突卡片", await conflictCard.count() === 1);
const ccText = await conflictCard.innerText();
check("冲突面板列出本地 88 与对端 72（双方都不丢）",
  ccText.includes("88") && ccText.includes("72"), ccText.replace(/\n/g, " ").slice(0, 140));
check("冲突面板标注修订号 r 变化", /共同基线 r\d+/.test(ccText) && /对端已保存 r\d+/.test(ccText));

// page1 选“本标签页=88”并合并
await conflictCard.locator("tr", { hasText: "数值" }).locator("label").filter({ hasText: "本标签页" }).locator("input").check();
await conflictCard.getByRole("button", { name: /按选择合并保存/ }).click();
await page.waitForTimeout(700);
check("选择本标签页后常温 S=88",
  await speedRow(page, "S").locator("input").nth(0).inputValue() === "88");

// page2 刷新看到 88（对端未被静默覆盖：它的 72 在冲突期间保留在面板，合并以用户选择为准）
await page2.reload({ waitUntil: "networkidle" });
await page2.waitForTimeout(800);
const finalP2 = await speedRow(page2, "S").locator("input").nth(0).inputValue();
check("另一标签页刷新后看到合并结果 88", finalP2 === "88", finalP2);

// 修订历史：工况修订号已增加，且历史中保留旧值
check("常温工况修订号已大于 1",
  Number((await page.locator(".scn-tab.active .rev-badge").innerText()).replace("r", "")) > 1);

await page2.close();

// ---------- E. 导入旧版 v1 笔记 ----------
const v1 = JSON.stringify({
  app: "dimension-notebook",
  version: 1,
  exportedAt: "2024-01-01T00:00:00.000Z",
  formulas: [{
    id: "v1_formula_1",
    latex: "s/t",
    note: "旧版速度",
    variables: { s: { value: "100", unit: "m" }, t: { value: "10", unit: "s" } },
    targetUnit: "km/h",
    createdAt: Date.now() - 100000,
  }],
});
await page.setInputFiles("input[type=file]", {
  name: "old.json", mimeType: "application/json", buffer: Buffer.from(v1),
});
await page.waitForTimeout(900);
const notice = await page.locator(".notice").innerText();
check("导入提示旧版迁移与可追溯默认工况", notice.includes("旧版") && notice.includes("默认工况"), notice);
// 选中导入的工况
await page.locator(".scn-tab", { hasText: "旧版导入" }).first().click();
await page.waitForTimeout(400);
const oldCard = page.locator("main .card[data-note='旧版速度']").first();
check("旧公式结果仍为 36 km/h", /36/.test(await oldCard.locator(".result-row .tex-box").innerText()));
check("旧公式显示旧版来源横幅", (await oldCard.innerText()).includes("旧版公式"));
check("旧字段标注“旧版自带”或来自公共默认", await oldCard.locator(".src-legacy, .src-default").count() >= 1);
// 刷新后仍在
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
check("刷新后旧版公式仍在", await page.locator("main .card[data-note='旧版速度']").count() === 1);
check("刷新后旧版导入工况仍在", await page.locator(".scn-tab", { hasText: "旧版导入" }).count() === 1);

// ---------- 缺变量不取零 ----------
await page.getByRole("button", { name: "＋ 新建公式" }).click();
await page.waitForTimeout(300);
const emptyCard = page.locator(".card").last();
await emptyCard.locator("math-field").evaluate((el, v) => {
  el.setValue(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, "z/2");
await page.waitForTimeout(400);
check("缺变量 z：报未赋值且不取零",
  (await emptyCard.locator(".badge").innerText()).includes("错误") &&
  (await emptyCard.innerText()).includes("未赋值"));

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length) {
  console.log("浏览器控制台错误：", JSON.stringify([...new Set(consoleErrors)].slice(0, 8), null, 1));
}
await browser.close();
if (failed.length) process.exit(1);
