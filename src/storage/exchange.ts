// 笔记导出 / 导入（v2：参数工况集 + 公共默认变量 + 快照 + 修订历史）。
// 保留可编辑的 LaTeX；旧版（version 1，无工况概念）文件导入时生成可追溯的默认工况。
import { latexToSource, LatexConvertError } from "../engine/latex";
import type {
  CalcSnapshot, Formula, PublicDefaultsDoc, Scenario,
  ScenarioVar, VariableDef,
} from "../engine/types";
import {
  DEFAULT_SCENARIO_ID, makeDefaultScenario, makeDefaults, sanitizeScenarioVars,
  sanitizeVarDefs,
} from "../engine/scenarios";
import { newId } from "./id";

// ---------- v2 ----------

export interface ExportFileV2 {
  app: "dimension-notebook";
  version: 2;
  exportedAt: string;
  defaults?: ExportDefaults;
  scenarios: ExportScenario[];
  formulas: ExportFormulaV2[];
  snapshots?: CalcSnapshot[];
}

export interface ExportDefaults {
  variables: Record<string, VariableDef>;
  rev: number;
  updatedAt?: number;
  origin?: string;
}

export interface ExportScenario {
  id: string;
  name: string;
  rev: number;
  /** 覆盖表：仅被覆盖的字段 */
  variables: Record<string, ScenarioVar>;
  createdAt: number;
  updatedAt: number;
  origin?: string;
  /** 修订历史（导出完整，旧记录可追溯版本） */
  history?: Scenario["history"];
}

export interface ExportFormulaV2 {
  id: string;
  latex: string;
  note: string;
  source?: string;
  targetUnit: string;
  createdAt: number;
  updatedAt?: number;
  legacyVariables?: Record<string, VariableDef>;
  legacyOrigin?: string;
}

// ---------- v1（旧版，无工况概念） ----------

interface ExportFileV1 {
  app: "dimension-notebook";
  version: 1;
  exportedAt?: string;
  formulas: Array<{
    id?: string;
    latex: string;
    note?: string;
    source?: string;
    variables?: Record<string, unknown>;
    targetUnit?: string;
    createdAt?: number;
  }>;
}

export interface ExportBundle {
  defaults: PublicDefaultsDoc;
  scenarios: Scenario[];
  formulas: Formula[];
  snapshots: CalcSnapshot[];
  /** 导入来源说明（写入 defaults.origin / scenario.origin / formula.legacyOrigin） */
  migrated: boolean;
  migratedAt: number;
}

export function buildExport(
  formulas: Formula[],
  scenarios: Scenario[],
  defaults: PublicDefaultsDoc,
  snapshots: CalcSnapshot[] = [],
): ExportFileV2 {
  return {
    app: "dimension-notebook",
    version: 2,
    exportedAt: new Date().toISOString(),
    defaults: {
      variables: defaults.variables,
      rev: defaults.rev,
      updatedAt: defaults.updatedAt,
      origin: defaults.origin,
    },
    scenarios: scenarios.map((s) => ({
      id: s.id, name: s.name, rev: s.rev, variables: s.variables,
      createdAt: s.createdAt, updatedAt: s.updatedAt, origin: s.origin, history: s.history,
    })),
    formulas: formulas.map((f) => {
      let source: string | undefined;
      try {
        source = latexToSource(f.latex).source;
      } catch (e) {
        if (e instanceof LatexConvertError) source = undefined;
      }
      return {
        id: f.id, latex: f.latex, note: f.note, source, targetUnit: f.targetUnit,
        createdAt: f.createdAt, updatedAt: f.updatedAt,
        legacyVariables: f.legacyVariables, legacyOrigin: f.legacyOrigin,
      };
    }),
    snapshots: snapshots.map((s) => ({ ...s })),
  };
}

export function downloadJSON(data: ExportFileV2): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `量纲笔记_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  bundle?: ExportBundle;
  errors: string[];
  /** 1 = 旧版格式（已迁移生成默认工况）；2 = 现版 */
  sourceVersion?: 1 | 2;
}

/**
 * 解析导入文件。
 * - v1（无工况）：公共默认 = 全部公式变量并集；生成可追溯“默认工况（由旧版导入）”，
 *   每条公式保留 legacyVariables，保证旧公式永远按原值计算且能说明来源；
 * - v2：工况 / 默认 / 快照（id 冲突重映射，快照内的旧 id 同步改写）一同导入。
 */
export function parseImport(text: string, existingIds: Set<string>): ImportResult {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { errors: ["文件不是合法的 JSON"] };
  }
  const obj = raw as Partial<ExportFileV2> & Partial<ExportFileV1>;
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"] };
  }

  const now = Date.now();

  if ((obj.version ?? 1) === 1) {
    return parseV1(obj as ExportFileV1, errors, now, existingIds);
  }
  return parseV2(obj as ExportFileV2, errors, now, existingIds);
}

// ---------- v1 迁移 ----------

function parseV1(file: ExportFileV1, errors: string[], now: number, existingIds: Set<string>): ImportResult {
  const formulas: Formula[] = [];
  const union: Record<string, VariableDef> = {};
  const usedIds = new Set<string>(existingIds);

  file.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }

    const vars = sanitizeVarDefs(f.variables);
    for (const [k, v] of Object.entries(vars)) {
      if (!union[k]) union[k] = { ...v };
      else {
        if (!union[k].value && v.value) union[k].value = v.value;
        if (!union[k].unit && v.unit) union[k].unit = v.unit;
      }
    }
    let id = typeof f.id === "string" ? f.id : newId();
    if (usedIds.has(id)) id = uniqueId("f", usedIds);
    else usedIds.add(id);
    formulas.push({
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      createdAt: typeof f.createdAt === "number" ? f.createdAt : now,
      updatedAt: now,
      legacyVariables: vars,
      legacyOrigin: `旧版（v1，无工况概念）导入保留的公式自带赋值 · ${new Date(now).toLocaleString()}`,
    });
  });

  if (formulas.length === 0) return { errors: errors.length ? errors : ["文件中没有可导入的公式"] };

  const defaults = makeDefaults(union, now);
  defaults.origin = `由旧版（v1，无工况概念）JSON 导入迁移生成 · ${new Date(now).toLocaleString()}`;

  const scenario = makeDefaultScenario(now);
  if (usedIds.has(DEFAULT_SCENARIO_ID)) {
    scenario.id = uniqueId("scn", usedIds);
  } else {
    usedIds.add(DEFAULT_SCENARIO_ID);
  }
  scenario.name = "默认工况（旧版导入）";
  scenario.origin = `由旧版（v1）导入自动生成的可追溯默认工况，修订号从 ${scenario.rev} 起`;
  // 旧版没有覆盖概念：覆盖表为空，一切由 公共默认/legacy 解析
  scenario.variables = {};

  return {
    bundle: { defaults, scenarios: [scenario], formulas, snapshots: [], migrated: true, migratedAt: now },
    errors,
    sourceVersion: 1,
  };
}

// ---------- v2 ----------

function uniqueId(kind: string, used: Set<string>): string {
  let id = newId(kind);
  while (used.has(id)) id = newId(kind);
  used.add(id);
  return id;
}

function parseV2(file: ExportFileV2, errors: string[], now: number, existingIds: Set<string>): ImportResult {
  const used = new Set<string>(existingIds);
  const idMap = new Map<string, string>();
  const mapId = (oldId: string, kind: string): string => {
    if (!idMap.has(oldId)) idMap.set(oldId, uniqueId(kind, used));
    return idMap.get(oldId)!;
  };

  // 公式
  const formulas: Formula[] = [];
  file.formulas.forEach((f, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f || typeof f !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }
    const oldId = typeof f.id === "string" ? f.id : newId();
    const id = existingIds.has(oldId) ? mapId(oldId, "f") : oldId;
    if (!used.has(id)) used.add(id);
    formulas.push({
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      createdAt: typeof f.createdAt === "number" ? f.createdAt : now,
      updatedAt: typeof f.updatedAt === "number" ? f.updatedAt : now,
      legacyVariables: f.legacyVariables ? sanitizeVarDefs(f.legacyVariables) : undefined,
      legacyOrigin: typeof f.legacyOrigin === "string" ? f.legacyOrigin : undefined,
    });
  });

  // 工况（id 冲突整体重映射，保留 rev 与 history 以追溯版本）
  const scenarios: Scenario[] = [];
  for (const [i, sRaw] of (file.scenarios ?? []).entries()) {
    if (!sRaw || typeof sRaw !== "object" || typeof sRaw.name !== "string") {
      errors.push(`工况第 ${i + 1} 个：无效，已跳过`);
      continue;
    }
    const oldId = typeof sRaw.id === "string" ? sRaw.id : uniqueId("scn", used);
    let id = oldId;
    let remapped = false;
    if (existingIds.has(oldId) || used.has(oldId)) { id = mapId(oldId, "scn"); remapped = true; }
    else used.add(id);
    const rev = typeof sRaw.rev === "number" && sRaw.rev >= 1 ? Math.floor(sRaw.rev) : 1;
    const history = Array.isArray(sRaw.history)
      ? sRaw.history.filter((h) => h && typeof h.rev === "number" && h.variables && typeof h.variables === "object")
      : [];
    scenarios.push({
      id,
      name: sRaw.name + (remapped ? "（导入副本）" : ""),
      rev,
      variables: sanitizeScenarioVars(sRaw.variables),
      history: history.slice(0, 50),
      createdAt: typeof sRaw.createdAt === "number" ? sRaw.createdAt : now,
      updatedAt: typeof sRaw.updatedAt === "number" ? sRaw.updatedAt : now,
      origin: typeof sRaw.origin === "string" ? sRaw.origin : undefined,
    });
  }

  // 公共默认（与库中已有 defaults 合并：键不覆盖，保留双方）
  const defaults = makeDefaults(
    file.defaults && typeof file.defaults === "object" ? sanitizeVarDefs(file.defaults.variables) : {},
    now,
  );
  if (file.defaults) {
    defaults.rev = typeof file.defaults.rev === "number" ? file.defaults.rev : 1;
    defaults.origin = typeof file.defaults.origin === "string" ? file.defaults.origin : undefined;
  }

  // 快照（冻结记录；id 与 formulaId/scenarioId 跟随映射，保证仍能说明当时工况与版本）
  const snapshots: CalcSnapshot[] = [];
  for (const [i, snap] of (file.snapshots ?? []).entries()) {
    if (!snap || typeof snap !== "object" || typeof snap.formulaId !== "string" || !snap.analysis) {
      errors.push(`计算记录第 ${i + 1} 条：无效，已跳过`);
      continue;
    }
    const oldFid = snap.formulaId;
    const formulaId = idMap.get(oldFid) ?? oldFid;
    const formulaExists = formulas.some((f) => f.id === formulaId);
    const oldSid = typeof snap.scenarioId === "string" ? snap.scenarioId : DEFAULT_SCENARIO_ID;
    const scenarioId = idMap.get(oldSid) ?? oldSid;
    const scn = scenarios.find((s) => s.id === scenarioId);
    snapshots.push({
      ...snap,
      id: uniqueId("snap", used),
      formulaId,
      scenarioId,
      scenarioName: scn?.name ?? (typeof snap.scenarioName === "string" ? snap.scenarioName : "未知工况"),
      formulaDeleted: snap.formulaDeleted ?? !formulaExists,
      scenarioMissing: snap.scenarioMissing ?? !scn,
    });
  }

  if (formulas.length === 0 && scenarios.length === 0) {
    return { errors: errors.length ? errors : ["文件中没有可导入的内容"] };
  }

  // 若 v2 文件没有工况（理论上不会），补一个可追溯默认工况
  if (scenarios.length === 0) {
    const s = makeDefaultScenario(now);
    s.origin = "导入文件未含工况，自动生成可追溯默认工况";
    scenarios.push(s);
  }

  return {
    bundle: { defaults, scenarios, formulas, snapshots, migrated: false, migratedAt: now },
    errors,
    sourceVersion: 2,
  };
}
