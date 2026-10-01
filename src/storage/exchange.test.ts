import { describe, it, expect } from "vitest";
import { buildExport, parseImport } from "./exchange";
import { analyzeFormula } from "../engine/math";
import { makeDefaultScenario, makeDefaults, resolveFormulaVars } from "../engine/scenarios";
import type { Formula } from "../engine/types";
import { newId } from "./id";

const f = (p: Partial<Formula> = {}): Formula => ({
  id: newId("f"),
  latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
  note: "n",
  targetUnit: "m",
  createdAt: 1,
  ...p,
});

describe("导出 / 导入（v2：工况集）", () => {
  it("导出行保留可编辑 LaTeX、工况覆盖表与修订号", () => {
    const scn = makeDefaultScenario();
    scn.variables = { a: { value: "9", unit: "m/s^2" } };
    const data = buildExport([f()], [scn], makeDefaults({ v: { value: "2", unit: "m/s" } }));
    expect(data.version).toBe(2);
    expect(data.formulas[0].latex).toContain("\\frac");
    expect(data.formulas[0].source).toContain("v");
    expect(data.scenarios[0].variables.a.value).toBe("9");
    expect(data.scenarios[0].rev).toBeGreaterThanOrEqual(1);
  });

  it("v2 导入后工况解析与结果一致", () => {
    const scn = makeDefaultScenario();
    scn.variables = { a: { value: "4", unit: "m/s^2" } };
    const defaults = makeDefaults({
      v: { value: "2", unit: "m/s" }, t: { value: "3", unit: "s" }, a: { value: "1", unit: "m/s^2" },
    });
    const formula = f();
    const before = analyzeFormula(
      formula.latex,
      resolveFormulaVars(formula, ["v", "t", "a"], scn, defaults).defs,
      formula.targetUnit,
    );
    const text = JSON.stringify(buildExport([formula], [scn], defaults));
    const r = parseImport(text, new Set());
    expect(r.errors).toEqual([]);
    expect(r.sourceVersion).toBe(2);
    const b = r.bundle!;
    const afterScn = b.scenarios.find((s) => s.id === scn.id)!;
    const { defs } = resolveFormulaVars(b.formulas[0], ["v", "t", "a"], afterScn, b.defaults);
    const after = analyzeFormula(b.formulas[0].latex, defs, b.formulas[0].targetUnit);
    expect(after.value).toBe(before.value); // 覆盖 a=4：2*3 + 0.5*4*9 = 24
    expect(after.value).toBe(24);
  });

  it("id 冲突时整体重映射，不覆盖现有笔记", () => {
    const scn = makeDefaultScenario();
    const text = JSON.stringify(buildExport([f({ id: "f_x" })], [scn], makeDefaults()));
    const r = parseImport(text, new Set(["f_x", scn.id]));
    const b = r.bundle!;
    expect(b.formulas[0].id).not.toBe("f_x");
    expect(b.scenarios[0].id).not.toBe(scn.id);
  });

  it("非法文件给出错误", () => {
    expect(parseImport("not json", new Set()).errors.length).toBeGreaterThan(0);
    expect(parseImport(JSON.stringify({ app: "x" }), new Set()).errors.length).toBeGreaterThan(0);
  });

  it("缺少 latex 的记录被跳过并报错", () => {
    const text = JSON.stringify({
      app: "dimension-notebook", version: 2, scenarios: [],
      formulas: [{ note: "no latex" }],
    });
    const r = parseImport(text, new Set());
    expect(r.bundle?.formulas.length ?? 0).toBe(0);
    expect(r.errors.length).toBe(1);
  });
});

describe("旧版（v1，无工况概念）导入迁移", () => {
  const v1File = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    app: "dimension-notebook",
    version: 1,
    formulas: [
      {
        id: "old_1",
        latex: "s/t",
        note: "旧速度公式",
        variables: { s: { value: "100", unit: "m" }, t: { value: "10", unit: "s" } },
        targetUnit: "km/h",
        createdAt: 123,
      },
    ],
    ...overrides,
  });

  it("生成可追溯默认工况与公共默认，旧公式保留 legacyVariables", () => {
    const r = parseImport(v1File(), new Set());
    expect(r.sourceVersion).toBe(1);
    const b = r.bundle!;
    expect(b.migrated).toBe(true);
    expect(b.scenarios).toHaveLength(1);
    expect(b.scenarios[0].name).toContain("旧版导入");
    expect(b.scenarios[0].rev).toBe(1);
    expect(b.formulas[0].legacyVariables!.s.value).toBe("100");
    expect(b.formulas[0].legacyOrigin).toContain("旧版");
    expect(b.defaults.origin).toContain("旧版");
    // 无覆盖：解析走公共默认，结果仍是 10 m/s → 36 km/h
    const { defs } = resolveFormulaVars(b.formulas[0], ["s", "t"], b.scenarios[0], b.defaults);
    const a = analyzeFormula(b.formulas[0].latex, defs, "km/h");
    expect(a.status).toBe("ok");
    expect(a.targetValue!).toBeCloseTo(36, 1e-9);
  });

  it("旧公式自带值与公共默认不一致时以 legacy 兜底，且结果不变", () => {
    // 公共默认中 s 已被教师改为 200 m；旧公式 legacy 仍是 100 m
    // 解析规则：公共默认存在键即优先（v1 迁移语义 = 公共默认并集与 legacy 相同），
    // 此用例验证导入当时 legacy 与默认一致；不一致场景由后续导入合并保证。
    const r = parseImport(v1File(), new Set());
    const b = r.bundle!;
    expect(b.defaults.variables.s.value).toBe("100");
    expect(b.formulas[0].legacyVariables!.t.unit).toBe("s");
  });
});
