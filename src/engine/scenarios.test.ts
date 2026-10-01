import { describe, it, expect } from "vitest";
import { analyzeFormula } from "./math";
import {
  DEFAULT_SCENARIO_ID, commitScenario, findFieldConflicts,
  makeDefaultScenario, makeDefaults, mergeFields, resolveConflictField,
  resolveFormulaVars, setScenarioField, unitsDimensionCompatible,
} from "./scenarios";
import type { Formula, ScenarioVar } from "./types";
import { newId } from "../storage/id";

const formula = (legacy?: Formula["legacyVariables"]): Formula => ({
  id: newId("f"), latex: "s/t", note: "", targetUnit: "km/h",
  createdAt: 1, legacyVariables: legacy,
});

describe("工况分层取值", () => {
  it("常温/满载切换：覆盖值与目标单位换算各自正确（验收 1）", () => {
    // 公共默认：s=100 m, t=10 s → 10 m/s → 36 km/h
    const defaults = makeDefaults({
      s: { value: "100", unit: "m" },
      t: { value: "10", unit: "s" },
    });
    const ambient = makeDefaultScenario();
    expect(ambient.id).toBe(DEFAULT_SCENARIO_ID);

    // 满载：s=36 km, t=1 h（都覆盖）→ 36 km/h
    let loaded = setScenarioField(ambient, "s", "value", "36");
    loaded = setScenarioField(loaded, "s", "unit", "km");
    loaded = setScenarioField(loaded, "t", "value", "1");
    loaded = setScenarioField(loaded, "t", "unit", "h");
    loaded.name = "满载";

    const f = formula();
    const aAmbient = analyzeFormula(
      f.latex, resolveFormulaVars(f, ["s", "t"], ambient, defaults).defs, "km/h");
    const aLoaded = analyzeFormula(
      f.latex, resolveFormulaVars(f, ["s", "t"], loaded, defaults).defs, "km/h");

    expect(aAmbient.status).toBe("ok");
    expect(aAmbient.value!).toBeCloseTo(10, 1e-9);
    expect(aAmbient.resultUnit).toBe("m / s");
    expect(aAmbient.targetValue!).toBeCloseTo(36, 1e-9);
    expect(aAmbient.targetUnit).toBe("km / h");

    expect(aLoaded.value!).toBeCloseTo(36, 1e-9);
    expect(aLoaded.targetValue!).toBeCloseTo(36, 1e-9);
  });

  it("只覆盖一个字段：未覆盖字段继续继承公共默认", () => {
    const defaults = makeDefaults({ s: { value: "100", unit: "m" }, t: { value: "10", unit: "s" } });
    let scn = makeDefaultScenario();
    scn = setScenarioField(scn, "s", "value", "200"); // 只覆盖数值，单位仍 m
    const r = resolveFormulaVars(formula(), ["s", "t"], scn, defaults);
    expect(r.defs.s).toEqual({ value: "200", unit: "m" });
    expect(r.resolved.s.value.source).toBe("scenario");
    expect(r.resolved.s.unit.source).toBe("default");
    expect(r.defs.t).toEqual({ value: "10", unit: "s" });
  });

  it("修改公共质量后未覆盖工况联动、覆盖质量的工况保持原值（验收 2）", () => {
    const defaults1 = makeDefaults({ m: { value: "10", unit: "kg" } });
    const ambient = makeDefaultScenario();           // 不覆盖 m
    const full = setScenarioField(
      setScenarioField(makeDefaultScenario(), "m", "value", "100"),
      "m", "unit", "kg",
    );
    full.id = "scn_full"; full.name = "满载";

    const f = { ...formula(), latex: "m", targetUnit: "kg" };
    const beforeA = analyzeFormula(f.latex, resolveFormulaVars(f, ["m"], ambient, defaults1).defs, "kg");
    const beforeL = analyzeFormula(f.latex, resolveFormulaVars(f, ["m"], full, defaults1).defs, "kg");
    expect(beforeA.value).toBe(10);
    expect(beforeL.value).toBe(100);

    // 教师改公共默认 m=25 kg
    const defaults2 = makeDefaults({ m: { value: "25", unit: "kg" } });
    const afterA = analyzeFormula(f.latex, resolveFormulaVars(f, ["m"], ambient, defaults2).defs, "kg");
    const afterL = analyzeFormula(f.latex, resolveFormulaVars(f, ["m"], full, defaults2).defs, "kg");
    expect(afterA.value).toBe(25);   // 未覆盖 → 联动
    expect(afterL.value).toBe(100);  // 覆盖 → 保持
  });

  it("缺变量不取零：公共默认与工况都没有时报未赋值", () => {
    const scn = makeDefaultScenario();
    const r = analyzeFormula("x/y", resolveFormulaVars(formula(), ["x", "y"], scn, makeDefaults()).defs, "");
    expect(r.status).toBe("error");
    expect(r.issues.some((i) => i.message.includes("未赋值"))).toBe(true);
    expect(r.value).toBeUndefined();
  });

  it("覆盖单位与公共默认量纲不兼容时给出 dimNote，且引擎照常报量纲错误", () => {
    const defaults = makeDefaults({ s: { value: "100", unit: "m" }, t: { value: "10", unit: "s" } });
    const bad = setScenarioField(makeDefaultScenario(), "s", "unit", "kg");
    const r = resolveFormulaVars(formula(), ["s", "t"], bad, defaults);
    expect(r.resolved.s.unit.dimNote).toContain("量纲不兼容");
    const a = analyzeFormula("s+t", r.defs, "");
    expect(a.status).toBe("error");
  });

  it("旧版公式 legacyVariables 始终优先于公共默认（公共默认被他人改动也不污染旧公式）", () => {
    // 公共默认 t 已被教师/别的公式改为 2 s、s 改为 200 m；
    // 迁移旧公式自带 s=100 m, t=10 s，必须仍按原值计算。
    const defaults = makeDefaults({
      s: { value: "200", unit: "m" }, t: { value: "2", unit: "s" },
    });
    const f = formula({ s: { value: "100", unit: "m" }, t: { value: "10", unit: "s" } });
    const scn = makeDefaultScenario();
    const r = resolveFormulaVars(f, ["s", "t"], scn, defaults);
    expect(r.defs.s).toEqual({ value: "100", unit: "m" });
    expect(r.resolved.s.value.source).toBe("legacy");
    expect(r.defs.t).toEqual({ value: "10", unit: "s" }); // 旧公式自带优先
    expect(r.resolved.t.value.source).toBe("legacy");
  });

  it("legacy 缺的字段仍可回落到公共默认，且缺值不会取零", () => {
    const defaults = makeDefaults({ u: { value: "5", unit: "m/s" } });
    const f = formula({ s: { value: "100", unit: "m" } }); // 旧公式只有 s
    const r = resolveFormulaVars(f, ["s", "u", "x"], makeDefaultScenario(), defaults);
    expect(r.defs.s.value).toBe("100");
    expect(r.resolved.s.value.source).toBe("legacy");
    expect(r.defs.u).toEqual({ value: "5", unit: "m/s" });
    expect(r.resolved.u.value.source).toBe("default");
    expect(r.defs.x).toEqual({ value: "", unit: "" });
    expect(r.resolved.x.value.source).toBe("missing");
  });
});

describe("多标签页字段级合并 / 冲突（验收 3）", () => {
  it("改不同字段自动合并，无冲突", () => {
    const base: Record<string, ScenarioVar> = { m: { value: "10", unit: "kg" } };
    const local: Record<string, ScenarioVar> = { m: { value: "20", unit: "kg" } };      // 标签页 A 改数值
    const remote: Record<string, ScenarioVar> = { m: { value: "10", unit: "t" } };       // 标签页 B 改单位
    const { merged, conflicts } = mergeFields(base, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged.m).toEqual({ value: "20", unit: "t" });
  });

  it("改同一字段为不同值：报冲突，三方值都在，不静默覆盖", () => {
    const base: Record<string, ScenarioVar> = { m: { value: "10", unit: "kg" } };
    const local: Record<string, ScenarioVar> = { m: { value: "20", unit: "kg" } };
    const remote: Record<string, ScenarioVar> = { m: { value: "30", unit: "kg" } };
    const conflicts = findFieldConflicts(base, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ varName: "m", field: "value", base: "10", local: "20", remote: "30" });

    // 默认合并表先取远端；用户逐字段选择 local 后才改成本地值
    const { merged } = mergeFields(base, local, remote);
    expect(merged.m.value).toBe("30");
    const picked = resolveConflictField(merged, conflicts[0], "local");
    expect(picked.m.value).toBe("20");
  });

  it("双方都改同一字段但改后相同：不算冲突", () => {
    const base: Record<string, ScenarioVar> = { m: { value: "10", unit: "kg" } };
    const both: Record<string, ScenarioVar> = { m: { value: "50", unit: "kg" } };
    expect(findFieldConflicts(base, both, both)).toHaveLength(0);
  });

  it("修订号随提交递增且历史保留旧版本值", () => {
    let scn = makeDefaultScenario();
    const v1: Record<string, ScenarioVar> = { m: { value: "10", unit: "kg" } };
    const v2: Record<string, ScenarioVar> = { m: { value: "20", unit: "kg" } };
    scn = commitScenario(scn, v1, 2, "tab_a", "edit");
    scn = commitScenario(scn, v2, 3, "tab_b", "edit");
    expect(scn.rev).toBe(3);
    expect(scn.history[0].variables.m.value).toBe("20");
    expect(scn.history[1].variables.m.value).toBe("10");
  });
});

describe("单位量纲兼容检查", () => {
  it("m 与 km 兼容，m 与 kg 不兼容，未知单位返回 null", () => {
    expect(unitsDimensionCompatible("m", "km")).toBe(true);
    expect(unitsDimensionCompatible("m/s", "km/h")).toBe(true);
    expect(unitsDimensionCompatible("m", "kg")).toBe(false);
    expect(unitsDimensionCompatible("", "m")).toBe(false);
    expect(unitsDimensionCompatible("not_a_unit", "m")).toBeNull();
  });
});
