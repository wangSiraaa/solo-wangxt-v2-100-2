// 笔记导出 / 导入（JSON）：
//  - v2：随工况集、公共默认变量、修订号与计算快照一起导出，重新导入后仍可按工况编辑；
//  - v1：没有工况概念的旧文件，导入时自动迁移出可追溯的“默认工况（旧笔记迁移）”。
import { latexToSource, LatexConvertError } from "../engine/latex";
import {
  DEFAULT_CONDITION_ID, MIGRATED_CONDITION_ID, migrateLegacyFormulas, normalizeField,
} from "../engine/conditions";
import type {
  CalcSnapshot, Condition, FieldValue, Formula, Notebook, VariableDef,
} from "../engine/types";
import { newId, newSnapshotId } from "./db";

// ---------- v2 导出 ----------

export interface ExportFileV2 {
  app: "dimension-notebook";
  version: 2;
  exportedAt: string;
  formulas: ExportFormulaV2[];
  defaults: Record<string, FieldValue>;
  defaultsRev: number;
  conditions: Condition[];
  activeConditionId: string | null;
  snapshots: CalcSnapshot[];
}

export interface ExportFormulaV2 {
  id: string;
  latex: string;
  note: string;
  source?: string;
  targetUnit: string;
  legacyVariables?: Record<string, VariableDef>;
  createdAt: number;
}

// ---------- v1 导出（保留旧格式读取能力） ----------

export interface ExportFileV1 {
  app: "dimension-notebook";
  version: 1;
  exportedAt: string;
  formulas: {
    id: string; latex: string; note: string; source?: string;
    variables: Record<string, VariableDef>; targetUnit: string; createdAt: number;
  }[];
}

export type ExportFile = ExportFileV2;

export function buildExport(
  formulas: Formula[],
  notebook: Notebook,
  snapshots: CalcSnapshot[] = [],
): ExportFileV2 {
  return {
    app: "dimension-notebook",
    version: 2,
    exportedAt: new Date().toISOString(),
    formulas: formulas.map((f) => {
      let source: string | undefined;
      try {
        source = latexToSource(f.latex).source;
      } catch (e) {
        if (e instanceof LatexConvertError) source = undefined;
      }
      const out: ExportFormulaV2 = {
        id: f.id, latex: f.latex, note: f.note, source,
        targetUnit: f.targetUnit, createdAt: f.createdAt,
      };
      if (f.legacyVariables && Object.keys(f.legacyVariables).length) out.legacyVariables = f.legacyVariables;
      return out;
    }),
    defaults: notebook.defaults,
    defaultsRev: notebook.defaultsRev,
    conditions: notebook.conditions,
    activeConditionId: notebook.activeConditionId,
    snapshots,
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

// ---------- 导入 ----------

export interface ImportPayload {
  formulas: Formula[];
  notebook: Notebook;
  snapshots: CalcSnapshot[];
  errors: string[];
  /** 迁移/校验产生的可展示说明 */
  notices: string[];
  legacy: boolean;
}

interface TakenIds {
  formula: Set<string>;
  condition: Set<string>;
  snapshot: Set<string>;
}

function remapId(id: string, taken: Set<string>, prefix: string): string {
  let next = id;
  if (!taken.has(next)) { taken.add(next); return next; }
  next = newId(prefix);
  while (taken.has(next)) next = newId(prefix);
  taken.add(next);
  return next;
}

function sanitizeField(v: unknown): FieldValue | null {
  if (!v || typeof v !== "object") return null;
  const vv = v as Partial<FieldValue>;
  if (typeof vv.value !== "string" && typeof vv.value !== "number") return null;
  return normalizeField({ value: String(vv.value ?? ""), unit: String(vv.unit ?? "") });
}

function sanitizeFieldMap(raw: unknown): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const f = sanitizeField(v);
      if (f) out[k] = f;
    }
  }
  return out;
}

/**
 * 解析并校验导入文件。
 * v1（无工况）→ 自动迁移出可追溯的默认工况；v2 → 保留工况/默认/快照与修订号。
 * 与现有 id 冲突时重新生成 id，绝不覆盖现有笔记。
 */
export function parseImport(text: string, existing: {
  formulaIds: Set<string>; conditionIds: Set<string>; snapshotIds: Set<string>;
}): ImportPayload {
  const errors: string[] = [];
  const notices: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { formulas: [], notebook: emptyNotebook(), snapshots: [], errors: ["文件不是合法的 JSON"], notices, legacy: false };
  }
  const obj = raw as Record<string, unknown> & {
    app?: unknown; version?: number; formulas?: unknown[];
    defaults?: unknown; defaultsRev?: unknown; conditions?: unknown;
    activeConditionId?: unknown; snapshots?: unknown;
  };
  if (!obj || obj.app !== "dimension-notebook" || !Array.isArray(obj.formulas)) {
    return { formulas: [], notebook: emptyNotebook(), snapshots: [], errors: ["不是本工具导出的笔记文件（缺少 app/formulas 字段）"], notices, legacy: false };
  }

  const version = obj.version === 2 ? 2 : 1;
  const taken: TakenIds = {
    formula: new Set(existing.formulaIds),
    condition: new Set(existing.conditionIds),
    snapshot: new Set(existing.snapshotIds),
  };

  // ---- v1：无工况概念 → 迁移 ----
  if (version === 1) {
    const legacyRows: { id: string; latex: string; note: string; targetUnit: string; createdAt: number;
                        variables: Record<string, FieldValue> }[] = [];
    (obj.formulas as unknown[]).forEach((f0, i) => {
      const label = `第 ${i + 1} 条`;
      if (!f0 || typeof f0 !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
      const f = f0 as Record<string, unknown>;
      if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }
      const id = remapId(typeof f.id === "string" ? f.id : newId("f"), taken.formula, "f");
      legacyRows.push({
        id,
        latex: f.latex,
        note: typeof f.note === "string" ? f.note : "",
        targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
        createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
        variables: sanitizeFieldMap(f.variables),
      });
    });

    const migrated = migrateLegacyFormulas(legacyRows);
    // 迁移工况 id 也要避免与现有工况冲突
    if (taken.condition.has(migrated.notebook.conditions[0].id)) {
      migrated.notebook.conditions[0].id = remapId(newId("cond"), taken.condition, "cond");
      migrated.notebook.activeConditionId = migrated.notebook.conditions[0].id;
    } else {
      taken.condition.add(migrated.notebook.conditions[0].id);
    }
    notices.push("旧版（无工况）笔记已迁移：自动生成可追溯的“默认工况（旧笔记迁移）”，公共变量进入公共默认层，公式间取值不同的变量保留为各公式私有遗留值");
    notices.push(...migrated.notices);

    return {
      formulas: migrated.formulas,
      notebook: migrated.notebook,
      snapshots: [],
      errors,
      notices,
      legacy: true,
    };
  }

  // ---- v2 ----
  const formulas: Formula[] = [];
  const formulaIdMap = new Map<string, string>();
  (obj.formulas as unknown[]).forEach((f0, i) => {
    const label = `第 ${i + 1} 条`;
    if (!f0 || typeof f0 !== "object") { errors.push(`${label}：不是有效对象，已跳过`); return; }
    const f = f0 as Record<string, unknown>;
    if (typeof f.latex !== "string") { errors.push(`${label}：缺少 latex 表达式，已跳过`); return; }
    const oldId = typeof f.id === "string" ? f.id : newId("f");
    const id = remapId(oldId, taken.formula, "f");
    formulaIdMap.set(oldId, id);
    const out: Formula = {
      id,
      latex: f.latex,
      note: typeof f.note === "string" ? f.note : "",
      targetUnit: typeof f.targetUnit === "string" ? f.targetUnit : "",
      createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
    };
    const legacyVars = sanitizeFieldMap(f.legacyVariables);
    if (Object.keys(legacyVars).length) out.legacyVariables = legacyVars;
    formulas.push(out);
  });

  // 工况
  const conditions: Condition[] = [];
  const conditionIdMap = new Map<string, string>();
  const rawConditions: unknown[] = Array.isArray(obj.conditions) ? obj.conditions as unknown[] : [];
  rawConditions.forEach((c0, i) => {
    const label = `工况第 ${i + 1} 条`;
    if (!c0 || typeof c0 !== "object") { errors.push(`${label}：无效，已跳过`); return; }
    const c = c0 as Record<string, unknown>;
    if (typeof c.name !== "string") { errors.push(`${label}：缺少名称，已跳过`); return; }
    const oldId = typeof c.id === "string" ? c.id : newId("cond");
    const id = remapId(oldId, taken.condition, "cond");
    conditionIdMap.set(oldId, id);
    conditions.push({
      id,
      name: c.name,
      rev: typeof c.rev === "number" && c.rev > 0 ? c.rev : 1,
      overrides: sanitizeFieldMap(c.overrides),
      overrideRevs: Object.fromEntries(
        Object.entries((c.overrideRevs ?? {}) as Record<string, unknown>)
          .filter(([, v]) => typeof v === "number") as [string, number][],
      ),
      description: typeof c.description === "string" ? c.description : "",
      createdAt: typeof c.createdAt === "number" ? c.createdAt : Date.now(),
      updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : Date.now(),
      ...(c.deleted ? { deleted: true, deletedAt: typeof c.deletedAt === "number" ? c.deletedAt : Date.now() } : {}),
    });
  });
  if (!conditions.length) {
    errors.push("文件中没有有效工况，已整体补建一个默认工况");
    conditions.push({
      id: taken.condition.has(DEFAULT_CONDITION_ID)
        ? remapId(newId("cond"), taken.condition, "cond") : DEFAULT_CONDITION_ID,
      name: "默认工况", rev: 1, overrides: {}, overrideRevs: {},
      description: "", createdAt: Date.now(), updatedAt: Date.now(),
    });
    taken.condition.add(conditions[0].id);
  }

  let activeConditionId: string | null = null;
  if (typeof obj.activeConditionId === "string") {
    activeConditionId = conditionIdMap.get(obj.activeConditionId)
      ?? (taken.condition.has(obj.activeConditionId) ? null : obj.activeConditionId);
  }
  if (!activeConditionId || !conditions.some((c) => c.id === activeConditionId)) {
    activeConditionId = conditions.find((c) => c.id === MIGRATED_CONDITION_ID)?.id
      ?? conditions.find((c) => !c.deleted)?.id ?? conditions[0].id;
  }

  const notebook: Notebook = {
    id: "main",
    defaults: sanitizeFieldMap(obj.defaults),
    defaultsRev: typeof obj.defaultsRev === "number" && obj.defaultsRev > 0 ? obj.defaultsRev : 1,
    conditions,
    activeConditionId,
    schemaVersion: 2,
    updatedAt: Date.now(),
  };

  // 快照：重映射公式/工况 id 与自身 id；引用缺失也保留（旧记录必须仍能说明当时工况与版本）
  const snapshots: CalcSnapshot[] = [];
  const rawSnaps: unknown[] = Array.isArray(obj.snapshots) ? obj.snapshots as unknown[] : [];
  rawSnaps.forEach((s0) => {
    if (!s0 || typeof s0 !== "object") return;
    const s = s0 as Record<string, unknown>;
    if (typeof s.formulaId !== "string" || typeof s.conditionId !== "string") return;
    // 公式/工况 id 跟随主体重映射；引用的主体在文件中缺失时保留原值（悬空引用不影响其他记录）
    const mappedFormula = formulaIdMap.get(s.formulaId) ?? s.formulaId;
    const mappedCondition = conditionIdMap.get(s.conditionId) ?? s.conditionId;
    const id = remapId(typeof s.id === "string" ? s.id : newSnapshotId(), taken.snapshot, "snap");
    const status = s.status;
    snapshots.push({
      id,
      formulaId: mappedFormula,
      conditionId: mappedCondition,
      conditionName: typeof s.conditionName === "string" ? s.conditionName : "",
      conditionRev: typeof s.conditionRev === "number" ? s.conditionRev : 0,
      defaultsRev: typeof s.defaultsRev === "number" ? s.defaultsRev : 0,
      variables: sanitizeFieldMap(s.variables) as Record<string, VariableDef>,
      fieldSources: sanitizeFieldSources(s.fieldSources),
      latex: typeof s.latex === "string" ? s.latex : "",
      targetUnit: typeof s.targetUnit === "string" ? s.targetUnit : "",
      status: status === "ok" || status === "unverified" || status === "error" || status === "empty"
        ? status : "error",
      summary: typeof s.summary === "string" ? s.summary : "",
      ...(typeof s.value === "number" ? { value: s.value } : {}),
      ...(typeof s.resultUnit === "string" ? { resultUnit: s.resultUnit } : undefined),
      ...(typeof s.targetValue === "number" ? { targetValue: s.targetValue } : {}),
      ...(typeof s.targetUnitResult === "string" ? { targetUnitResult: s.targetUnitResult } : undefined),
      ...(typeof s.source === "string" ? { source: s.source } : undefined),
      ...(typeof s.substituted === "string" ? { substituted: s.substituted } : undefined),
      createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
    });
  });

  return { formulas, notebook, snapshots, errors, notices, legacy: false };
}

/** 旧计算快照中的字段来源标记 */
function sanitizeFieldSources(raw: unknown): Record<string, "override" | "default" | "legacy" | "missing"> {
  const out: Record<string, "override" | "default" | "legacy" | "missing"> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === "override" || v === "default" || v === "legacy" || v === "missing") out[k] = v;
    }
  }
  return out;
}

function emptyNotebook(): Notebook {
  return {
    id: "main", defaults: {}, defaultsRev: 1, conditions: [],
    activeConditionId: null, schemaVersion: 2, updatedAt: Date.now(),
  };
}
