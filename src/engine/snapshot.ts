// 计算快照：在某次计算发生时冻结“当时使用的工况、修订号与实际变量”，
// 使旧计算记录在后续修改/删除工况、刷新页面后仍能说明用了哪套工况、哪个版本。
import { analyzeFormula } from "./math";
import type {
  CalcSnapshot, Condition, FieldResolution, FieldValue, Formula, Notebook,
} from "./types";
import { newSnapshotId } from "../storage/db";

export interface SnapshotInput {
  formula: Formula;
  condition: Condition | undefined;
  notebook: Notebook;
  /** 该公式本次实际使用的解析后字段 */
  resolved: Record<string, FieldResolution>;
}

/** 仅在公式非空时生成快照（空公式不产生历史记录） */
export function buildSnapshot(input: SnapshotInput, now = Date.now()): CalcSnapshot | null {
  const { formula, condition, notebook, resolved } = input;
  if (!formula.latex.trim()) return null;

  const variables: Record<string, FieldValue> = {};
  const fieldSources: CalcSnapshot["fieldSources"] = {};
  for (const [name, r] of Object.entries(resolved)) {
    variables[name] = { value: r.value, unit: r.unit };
    fieldSources[name] = r.source;
  }

  const result = analyzeFormula(formula.latex, variables, formula.targetUnit);
  const conditionId = condition?.id ?? "none";
  return {
    id: newSnapshotId(),
    formulaId: formula.id,
    conditionId,
    conditionName: condition ? condition.name : "（无可用工况）",
    conditionRev: condition?.rev ?? 0,
    defaultsRev: notebook.defaultsRev,
    variables,
    fieldSources,
    latex: formula.latex,
    targetUnit: formula.targetUnit,
    status: result.status,
    summary: result.summary ?? "",
    ...(result.value !== undefined ? { value: result.value } : {}),
    ...(result.resultUnit !== undefined ? { resultUnit: result.resultUnit } : {}),
    ...(result.targetValue !== undefined ? { targetValue: result.targetValue } : {}),
    ...(result.targetUnit !== undefined ? { targetUnitResult: result.targetUnit } : {}),
    ...(result.source !== undefined ? { source: result.source } : {}),
    ...(result.substituted !== undefined ? { substituted: result.substituted } : {}),
    createdAt: now,
  };
}

/** 快照是否与上一次相同（公式/工况/默认层修订号 + 内容指纹），避免重复历史 */
export function snapshotFingerprint(s: CalcSnapshot): string {
  return [
    s.formulaId, s.conditionId, s.conditionRev, s.defaultsRev,
    s.latex, s.targetUnit, JSON.stringify(s.variables),
  ].join("|");
}
