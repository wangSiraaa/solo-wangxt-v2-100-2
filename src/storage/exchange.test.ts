import { describe, it, expect } from "vitest";
import { buildExport, parseImport } from "./exchange";
import { analyzeFormula } from "../engine/math";
import type { Formula } from "../engine/types";
import { newId } from "./db";
import {
  DEFAULT_CONDITION_ID, MIGRATED_CONDITION_ID, makeCondition, makeNotebook,
  resetOverride, resolveField, setDefault, setOverride,
  mergeConditionEdits, migrateLegacyFormulas, unitCompatibilityError,
} from "../engine/conditions";

const noIds = () => ({ formulaIds: new Set<string>(), conditionIds: new Set<string>(), snapshotIds: new Set<string>() });

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId(),
  latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
  note: "n",
  targetUnit: "m",
  createdAt: 1,
  ...p,
});

describe("导出 / 导入 v2（工况）", () => {
  it("导出保留 LaTeX、公共默认、工况覆盖与修订号", () => {
    let nb = makeNotebook();
    nb = setDefault(nb, "v", { value: "2", unit: "m/s" }).notebook;
    const cond = nb.conditions[0];
    const updated = setOverride(cond, "v", { value: "5", unit: "m/s" }, nb.defaults);
    nb = { ...nb, conditions: [updated] };
    const data = buildExport([f()], nb, []);
    expect(data.version).toBe(2);
    expect(data.formulas[0].latex).toContain("\\frac");
    expect(data.defaults.v.unit).toBe("m/s");
    expect(data.conditions[0].overrides.v.value).toBe("5");
    expect(data.conditions[0].rev).toBeGreaterThan(1);
  });

  it("v2 导入后公式可重新分析，结果一致", () => {
    let nb = makeNotebook();
    nb = setDefault(nb, "v", { value: "2", unit: "m/s" }).notebook;
    nb = setDefault(nb, "t", { value: "3", unit: "s" }).notebook;
    nb = setDefault(nb, "a", { value: "4", unit: "m/s^2" }).notebook;
    const formula = f();
    const before = analyzeFormula(formula.latex, nb.defaults, formula.targetUnit);
    const text = JSON.stringify(buildExport([formula], nb, []));
    const r = parseImport(text, noIds());
    expect(r.errors).toEqual([]);
    expect(r.legacy).toBe(false);
    const after = analyzeFormula(r.formulas[0].latex, r.notebook.defaults, r.formulas[0].targetUnit);
    expect(after.status).toBe(before.status);
    expect(after.value).toBe(before.value);
    expect(r.formulas[0].latex).toBe(formula.latex);
    expect(r.notebook.conditions[0].rev).toBe(nb.conditions[0].rev);
  });

  it("id 冲突时公式与工况都重新生成，不覆盖现有笔记", () => {
    const nb = makeNotebook();
    const formula = f();
    const text = JSON.stringify(buildExport([formula], nb, []));
    const r = parseImport(text, {
      formulaIds: new Set([formula.id]),
      conditionIds: new Set([DEFAULT_CONDITION_ID]),
      snapshotIds: new Set(),
    });
    expect(r.formulas[0].id).not.toBe(formula.id);
    expect(r.notebook.conditions[0].id).not.toBe(DEFAULT_CONDITION_ID);
  });

  it("非法文件给出错误", () => {
    expect(parseImport("not json", noIds()).errors.length).toBeGreaterThan(0);
    expect(parseImport(JSON.stringify({ app: "x" }), noIds()).errors.length).toBeGreaterThan(0);
  });

  it("缺少字段的记录被跳过并报错", () => {
    const text = JSON.stringify({ app: "dimension-notebook", version: 2, formulas: [{ note: "no latex" }], conditions: [] });
    const r = parseImport(text, noIds());
    expect(r.formulas).toHaveLength(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("旧版（v1，无工况）笔记导入迁移", () => {
  it("生成可追溯的默认工况，变量进入公共默认层", () => {
    const v1 = {
      app: "dimension-notebook", version: 1, exportedAt: new Date().toISOString(),
      formulas: [{
        id: "f1", latex: "v*t", note: "", source: "v*t",
        variables: { v: { value: "3", unit: "m/s" }, t: { value: "2", unit: "s" } },
        targetUnit: "m", createdAt: 1,
      }],
    };
    const r = parseImport(JSON.stringify(v1), noIds());
    expect(r.legacy).toBe(true);
    expect(r.formulas).toHaveLength(1);
    const cond = r.notebook.conditions[0];
    expect(cond.id).toBe(MIGRATED_CONDITION_ID);
    expect(cond.name).toContain("旧笔记迁移");
    expect(r.notebook.defaults.v.value).toBe("3");
    // 迁移后公式在默认工况下仍能算出原值 6 m
    const res = analyzeFormula(r.formulas[0].latex, r.notebook.defaults, "m");
    expect(res.status).toBe("ok");
    expect(res.value).toBeCloseTo(6, 10);
    // 快照可追溯：迁移工况是普通工况，名字/修订号都在
    expect(cond.rev).toBeGreaterThanOrEqual(1);
  });

  it("公式间取值不同的变量保留为各公式私有遗留值，互不污染", () => {
    const v1 = {
      app: "dimension-notebook", version: 1,
      formulas: [
        { id: "f1", latex: "m", note: "", variables: { m: { value: "10", unit: "kg" } }, targetUnit: "", createdAt: 1 },
        { id: "f2", latex: "m", note: "", variables: { m: { value: "20", unit: "kg" } }, targetUnit: "", createdAt: 2 },
      ],
    };
    const r = parseImport(JSON.stringify(v1), noIds());
    expect(r.formulas[0].legacyVariables?.m.value).toBe("10");
    expect(r.formulas[1].legacyVariables?.m.value).toBe("20");
    expect(r.notebook.defaults.m).toBeUndefined();
    expect(r.notices.length).toBeGreaterThan(0);
  });
});

describe("工况解析：覆盖 / 继承 / 缺失", () => {
  it("公共默认更新只影响未覆盖字段，覆盖字段保持原值", () => {
    // 验收 2：修改公共质量 m，未覆盖工况更新；覆盖质量的工况保持原值
    let nb = makeNotebook();
    nb = setDefault(nb, "m", { value: "100", unit: "kg" }).notebook;
    const normal = nb.conditions[0];
    const full = makeCondition("满载");
    nb = { ...nb, conditions: [...nb.conditions, full] };

    // 在“满载”覆盖质量为 200 kg
    const full2 = setOverride(full, "m", { value: "200", unit: "kg" }, nb.defaults);
    nb = { ...nb, conditions: [normal, full2] };

    // 公共质量改成 120 kg
    nb = setDefault(nb, "m", { value: "120", unit: "kg" }).notebook;
    const normalAfter = nb.conditions[0];
    const fullAfter = nb.conditions[1];

    expect(resolveField("m", normalAfter, nb.defaults).value).toBe("120");
    expect(resolveField("m", normalAfter, nb.defaults).source).toBe("default");
    expect(resolveField("m", fullAfter, nb.defaults).value).toBe("200");
    expect(resolveField("m", fullAfter, nb.defaults).source).toBe("override");
  });

  it("恢复继承后字段跟随默认，缺失字段不取零", () => {
    let nb = makeNotebook();
    nb = setDefault(nb, "x", { value: "1", unit: "m" }).notebook;
    let c = setOverride(nb.conditions[0], "x", { value: "9", unit: "m" }, nb.defaults);
    expect(resolveField("x", c, nb.defaults).value).toBe("9");
    c = resetOverride(c, "x");
    const r = resolveField("x", c, nb.defaults);
    expect(r.value).toBe("1");
    expect(r.source).toBe("default");
    const missing = resolveField("ghost", c, nb.defaults);
    expect(missing.source).toBe("missing");
    expect(missing.value).toBe("");
  });

  it("同一速度公式在不同工况下结果与目标单位换算各自正确（验收 1）", () => {
    let nb = makeNotebook();
    // 公共默认：常温 s=100 m, t=10 s
    nb = setDefault(nb, "s", { value: "100", unit: "m" }).notebook;
    nb = setDefault(nb, "t", { value: "10", unit: "s" }).notebook;
    const normal = nb.conditions[0];
    normal.name = "常温";
    let full = makeCondition("满载");
    nb = { ...nb, conditions: [normal, full] };
    // 满载：s=36 km（只覆盖距离，时间继承默认）
    full = setOverride(full, "s", { value: "36", unit: "km" }, nb.defaults);
    nb = { ...nb, conditions: [normal, full] };

    for (const [name, cond, expected] of [
      ["常温", normal, 36],       // 100 m / 10 s = 10 m/s = 36 km/h
      ["满载", full, 12960],      // 36 km / 10 s = 3600 m/s = 12960 km/h
    ] as const) {
      const vars = {
        s: resolveField("s", cond, nb.defaults),
        t: resolveField("t", cond, nb.defaults),
      };
      const r = analyzeFormula("s/t", vars, "km/h");
      expect(r.status).toBe("ok");
      expect(r.targetValue, name).toBeCloseTo(expected, 6);
      expect(r.targetUnit).toBe("km / h");
    }
  });
});

describe("量纲校验", () => {
  it("覆盖单位与公共默认量纲不兼容时拒绝写入，不污染其他工况", () => {
    const withDefault = setDefault(makeNotebook(), "x", { value: "1", unit: "m" }).notebook;
    const c = withDefault.conditions[0];
    expect(() => setOverride(c, "x", { value: "2", unit: "kg" }, withDefault.defaults)).toThrow();
    // 原工况未被改动
    expect(c.overrides.x).toBeUndefined();
    expect(unitCompatibilityError("m", "kg")).toContain("量纲不兼容");
    expect(unitCompatibilityError("m/s", "km/h")).toBeNull();
  });

  it("删除公共默认后未覆盖工况变为缺失（不是零）", () => {
    let nb = makeNotebook();
    nb = setDefault(nb, "x", { value: "1", unit: "m" }).notebook;
    nb = setDefault(nb, "x", { value: "", unit: "" }).notebook;
    expect(nb.defaults.x).toBeUndefined();
    const r = resolveField("x", nb.conditions[0], nb.defaults);
    expect(r.source).toBe("missing");
    expect(r.value).toBe("");
  });
});

describe("多标签页三方合并（验收 3）", () => {
  it("改不同字段自动字段级合并", () => {
    const base = { overrides: {}, overrideRevs: {}, name: "常温" };
    // 标签页 A 改 m，标签页 B 改 v
    const local = { overrides: { m: { value: "1", unit: "kg" } }, overrideRevs: { m: 2 }, name: "常温" };
    const remote = { overrides: { v: { value: "3", unit: "m/s" } }, overrideRevs: { v: 2 }, name: "常温" };
    const m = mergeConditionEdits(base, local, remote);
    expect(m.conflicts).toHaveLength(0);
    expect(m.overrides.m.value).toBe("1");
    expect(m.overrides.v.value).toBe("3");
    expect(m.autoMerged.sort()).toEqual(["m", "v"]);
  });

  it("改同一字段产生冲突，双方值都保留，不静默覆盖", () => {
    const base = { overrides: { m: { value: "1", unit: "kg" } }, overrideRevs: { m: 1 }, name: "常温" };
    const local = { overrides: { m: { value: "2", unit: "kg" } }, overrideRevs: { m: 2 }, name: "常温" };
    const remote = { overrides: { m: { value: "3", unit: "kg" } }, overrideRevs: { m: 2 }, name: "常温" };
    const m = mergeConditionEdits(base, local, remote);
    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0].local?.value).toBe("2");
    expect(m.conflicts[0].remote?.value).toBe("3");
    expect(m.conflicts[0].base?.value).toBe("1");
  });

  it("只有一方修改单位、另一方未动该字段时安全合入，不丢单位", () => {
    const base = { overrides: { v: { value: "10", unit: "m/s" } }, overrideRevs: { v: 1 }, name: "常温" };
    const local = { overrides: { v: { value: "10", unit: "km/h" } }, overrideRevs: { v: 2 }, name: "常温" };
    const remote = base;
    const m = mergeConditionEdits(base, local, remote);
    expect(m.conflicts).toHaveLength(0);
    expect(m.overrides.v.unit).toBe("km/h");
  });
});

describe("直接迁移函数", () => {
  it("migrateLegacyFormulas 输出可追溯工况", () => {
    const r = migrateLegacyFormulas([{
      id: "x", latex: "a", note: "", targetUnit: "", createdAt: 1,
      variables: { a: { value: "1", unit: "m" } },
    }]);
    expect(r.notebook.activeConditionId).toBe(MIGRATED_CONDITION_ID);
    expect(r.formulas[0].legacyVariables).toBeUndefined();
    expect(r.notebook.defaults.a.value).toBe("1");
  });
});
