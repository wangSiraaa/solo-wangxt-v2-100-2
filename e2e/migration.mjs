// 验证 IndexedDB v1（旧库，无工况）升级到 v2 的原地迁移
import { chromium } from "playwright";
const URL = "http://localhost:5199/";
const browser = await chromium.launch({
  executablePath: "/home/node/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
let appPage = page;
const results = [];
const check = (n, c, d = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); };

// 1) 先建一个 v1 结构的库（version 1，只有 formulas store，旧字段结构）。
//    在一个阻止应用 JS 的页面上手工建库，然后关闭该页彻底释放连接；
//    再开全新页面加载应用触发 version 1→2 升级。
await page.route("**/main.tsx*", (route) => route.abort());
await page.goto(URL, { waitUntil: "commit" });
await page.waitForTimeout(500);

// 删除旧库 + 建 v1 库 + 彻底关闭，全部在一个 evaluate 里完成，
// 避免跨 evaluate 留下未释放的 IDB 连接阻塞应用的 versionchange 升级。
await page.evaluate(() => new Promise((resolve, reject) => {
  const d = indexedDB.deleteDatabase("dimension-notebook");
  d.onerror = () => reject(d.error);
  d.onblocked = () => reject(new Error("删除旧库被阻塞：仍有连接打开"));
  d.onsuccess = () => {
    const req = indexedDB.open("dimension-notebook", 1);
    req.onupgradeneeded = () => {
      const st = req.result.createObjectStore("formulas", { keyPath: "id" });
      st.add({
        id: "legacy_f1",
        latex: "s/t",
        note: "IDB旧公式",
        variables: { s: { value: "100", unit: "m" }, t: { value: "10", unit: "s" } },
        targetUnit: "km/h",
        createdAt: Date.now(),
      });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.close();
      // 给底层一个节拍真正释放连接
      setTimeout(resolve, 150);
    };
    req.onerror = () => reject(req.error);
  };
}));

// 2) 关闭建库页（释放全部连接），开全新页面加载应用 → 触发 version 1→2 升级
await page.unrouteAll().catch(() => undefined);
await page.close();
await new Promise((r) => setTimeout(r, 300));
appPage = await ctx.newPage();
await appPage.goto(URL, { waitUntil: "networkidle" });
await appPage.waitForTimeout(1500);
check("应用已启动", await appPage.locator(".app").count() === 1);

const state = await appPage.evaluate(() => new Promise((resolve, reject) => {
  const r = indexedDB.open("dimension-notebook");
  r.onsuccess = () => {
    const db = r.result;
    const version = db.version;
    const names = [...db.objectStoreNames];
    if (version < 2) { resolve({ names, version }); return; }
    check2(db).then(resolve, reject);
  };
  r.onerror = () => reject(r.error);
  async function check2(db) {
    const version = db.version;
    const names = [...db.objectStoreNames];
    const t = db.transaction(["formulas", "scenarios", "defaults", "meta"], "readonly");
    const f = await new Promise((res) => t.objectStore("formulas").get("legacy_f1").onsuccess = (e) => res(e.target.result));
    const ss = await new Promise((res) => t.objectStore("scenarios").getAll().onsuccess = (e) => res(e.target.result));
    const dd = await new Promise((res) => t.objectStore("defaults").get("defaults").onsuccess = (e) => res(e.target.result));
    const mm = await new Promise((res) => t.objectStore("meta").get("meta").onsuccess = (e) => res(e.target.result));
    resolve({ names, f, ss, dd, mm, version });
  }
}));
check("v2 建立了全部 7 个 store",
  ["formulas", "scenarios", "defaults", "snapshots", "conflicts", "trash", "meta"].every((s) => state.names.includes(s)),
  state.names.join(","));
check("旧公式保留并带 legacyVariables", !!state.f && state.f.legacyVariables?.s?.value === "100");
check("旧公式带 legacyOrigin 溯源", typeof state.f.legacyOrigin === "string" && state.f.legacyOrigin.includes("旧版"));
check("生成默认工况", state.ss.length === 1 && state.ss[0].name === "常温", state.ss[0]?.name);
check("默认工况带来源说明", (state.ss[0].origin || "").includes("旧版"));
check("公共默认由旧变量并集生成", state.dd.variables?.s?.value === "100" && state.dd.variables?.t?.unit === "s");
check("公共默认带来源说明", (state.dd.origin || "").includes("旧版"));
check("meta 指向默认工况", state.mm.activeScenarioId === state.ss[0].id);

// 3) UI 里旧公式可正常计算（36 km/h）
const card = appPage.locator("main .card[data-note='IDB旧公式']").first();
check("UI 中迁移后的旧公式已验证", (await card.locator(".badge").innerText()) === "已验证");
const result = await card.locator(".result-row .tex-box").innerText();
check("迁移后旧公式结果 36 km/h", /36/.test(result), result.replace(/\n/g, " "));
check("旧字段在 UI 标注“旧版自带”", await card.locator(".src-legacy").count() >= 1);
check("显示旧版来源横幅", (await card.innerText()).includes("旧版公式"));

// 4) 刷新后仍然可用（迁移幂等）
await appPage.reload({ waitUntil: "networkidle" });
await appPage.waitForTimeout(800);
check("再次刷新后旧公式仍可计算", /36/.test(await appPage.locator("main .card[data-note='IDB旧公式'] .result-row .tex-box").innerText()));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
await browser.close();
if (failed) process.exit(1);
