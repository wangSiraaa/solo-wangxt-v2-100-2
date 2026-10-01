// 计算快照：冻结“当时三段展示与结果”，并记录所用工况 id/名称/修订号与公共默认修订号。
import { analyzeFormula } from "../engine/math";
import type {
  AnalysisResult, CalcSnapshot, FieldSource, Formula, PublicDefaultsDoc,
  ResolvedVar, Scenario,
} from "../engine/types";
import { resolveFormulaVars } from "../engine/scenarios";
import { newId, TAB_ID } from "./id";

export function makeSnapshot(
  formula: Formula,
  varNames: string[],
  scenario: Scenario | undefined,
  defaults: PublicDefaultsDoc,
): CalcSnapshot {
  const { defs, resolved } = resolveFormulaVars(formula, varNames, scenario, defaults);
  const analysis = analyzeFormula(formula.latex, defs, formula.targetUnit);
  const vars: CalcSnapshot["vars"] = {};
  for (const [name, r] of Object.entries(resolved) as [string, ResolvedVar][]) {
    const source: FieldSource = r.value.source === "missing" ? r.unit.source : r.value.source;
    vars[name] = { value: defs[name].value, unit: defs[name].unit, source };
  }
  return {
    id: newId("snap"),
    formulaId: formula.id,
    formulaLatex: formula.latex,
    formulaNote: formula.note,
    createdAt: Date.now(),
    tabId: TAB_ID,
    analysis,
    targetUnit: formula.targetUnit,
    scenarioId: scenario?.id ?? "none",
    scenarioName: scenario?.name ?? "（无工况）",
    scenarioRev: scenario?.rev ?? 0,
    defaultsRev: defaults.rev,
    vars,
  };
}

/** 快照展示用的解析结果（永远返回冻结内容，不重算） */
export function snapshotAnalysis(s: CalcSnapshot): AnalysisResult {
  return s.analysis;
}
