// 参数工况集核心逻辑（纯函数，不依赖 DOM/IndexedDB，便于单测）：
// 字段解析（覆盖 → 公共默认 → 旧版遗留 → 缺失）、覆盖写入与量纲校验、
// 旧笔记迁移、以及多标签页修订冲突的三方合并。
import { create, all, type MathJsInstance } from "mathjs";
import { latexToSource, LatexConvertError } from "./latex";
import type {
  Condition, FieldResolution, FieldSource, FieldValue, Formula, Notebook,
} from "./types";

const math: MathJsInstance = create(all);

export const DEFAULT_CONDITION_ID = "cond_default";
export const MIGRATED_CONDITION_ID = "cond_legacy";
export const SCHEMA_VERSION = 2 as const;

// ---------- 变量名收集（供 UI 在解析字段前知道公式引用了哪些变量） ----------

const BUILTIN = new Set(["pi", "e", "PI", "E"]);

/** 从 LaTeX 公式中收集用户变量名；解析失败时返回空数组（引擎会另行报错） */
export function collectFormulaVarNames(latex: string): string[] {
  let src: string;
  try {
    src = latexToSource(latex).source;
  } catch (e) {
    if (e instanceof LatexConvertError) return [];
    throw e;
  }
  try {
    const node = math.parse(src);
    const out = new Set<string>();
    node.traverse((n) => {
      const sym = n as unknown as { isSymbolNode?: boolean; name?: string };
      if (sym.isSymbolNode && sym.name && !BUILTIN.has(sym.name)) out.add(sym.name);
    });
    return [...out];
  } catch {
    return [];
  }
}

// ---------- 基础工具 ----------

export function newConditionId(): string {
  return `cond_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeField(f: Partial<FieldValue> | undefined): FieldValue {
  return { value: String(f?.value ?? ""), unit: String(f?.unit ?? "").trim() };
}

export function fieldsEqual(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.value === b.value && a.unit === b.unit;
}

const isEmpty = (f: FieldValue | undefined): boolean => !f || (f.value === "" && f.unit === "");

// ---------- 单位量纲校验 ----------

/** 单位文本能否被 mathjs 识别；空串表示纯数（合法） */
export function unitParseError(unit: string): string | null {
  const t = unit.trim();
  if (!t) return null;
  try {
    math.unit(t);
    return null;
  } catch {
    return `单位“${t}”无法识别`;
  }
}

/**
 * 两个单位量纲是否兼容（空串 = 无量纲纯数）。
 * 不兼容时返回可展示给用户的原因；兼容返回 null。
 */
export function unitCompatibilityError(a: string, b: string): string | null {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta && !tb) return null;
  const pa = unitParseError(ta);
  if (pa) return pa;
  const pb = unitParseError(tb);
  if (pb) return pb;
  if (!ta || !tb) {
    return `量纲不兼容：${ta ? `“${ta}”是带单位量` : "一侧是纯数"}，${tb ? `“${tb}”是带单位量` : "另一侧是纯数"}`;
  }
  try {
    if (math.unit(ta).equalBase(math.unit(tb))) return null;
  } catch {
    // 落到下面的通用提示
  }
  return `量纲不兼容：“${ta}”与“${tb}”不属于同一量纲，不能在该字段上覆盖`;
}

// ---------- 工况构造 ----------

export function makeCondition(name: string, now = Date.now()): Condition {
  return {
    id: newConditionId(),
    name,
    rev: 1,
    overrides: {},
    overrideRevs: {},
    description: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function makeDefaultCondition(now = Date.now()): Condition {
  return { ...makeCondition("默认工况", now), id: DEFAULT_CONDITION_ID };
}

export function makeNotebook(now = Date.now()): Notebook {
  return {
    id: "main",
    defaults: {},
    defaultsRev: 1,
    conditions: [makeDefaultCondition(now)],
    activeConditionId: DEFAULT_CONDITION_ID,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
  };
}

export function activeCondition(nb: Notebook): Condition | undefined {
  if (!nb.activeConditionId) return undefined;
  return nb.conditions.find((c) => c.id === nb.activeConditionId);
}

/** 当前工况是否可用（存在且未被软删除） */
export function conditionUsable(nb: Notebook): boolean {
  const c = activeCondition(nb);
  return !!c && !c.deleted;
}

// ---------- 字段解析（继承 / 覆盖 / 缺失） ----------

export interface ResolveOptions {
  /** 该公式的旧版遗留变量（最后一级回退，绝不跨公式污染） */
  legacy?: Record<string, FieldValue>;
}

export function resolveField(
  name: string,
  condition: Condition | undefined,
  defaults: Record<string, FieldValue>,
  opts: ResolveOptions = {},
): FieldResolution {
  let source: FieldSource;
  let field: FieldValue | undefined;

  const ov = condition && !condition.deleted ? condition.overrides[name] : undefined;
  if (ov !== undefined) {
    field = ov;
    source = "override";
  } else if (defaults[name] !== undefined) {
    field = defaults[name];
    source = "default";
  } else if (opts.legacy && opts.legacy[name] !== undefined) {
    field = normalizeField(opts.legacy[name]);
    source = "legacy";
  } else {
    field = { value: "", unit: "" };
    source = "missing";
  }

  const out: FieldResolution = { ...field, source };
  if (source === "override") out.overrideRev = condition!.overrideRevs[name];
  // 公共默认单位事后被改成不同量纲时，旧覆盖不被静默改动，而是明确标红说明
  if (source === "override" && defaults[name] !== undefined) {
    const err = unitCompatibilityError(field.unit, defaults[name].unit);
    if (err) out.unitError = err;
  }
  return out;
}

/** 解析一组变量（公式实际使用 + 已定义但未引用的也一并给出） */
export function resolveFields(
  names: string[],
  condition: Condition | undefined,
  defaults: Record<string, FieldValue>,
  opts: ResolveOptions = {},
): Record<string, FieldResolution> {
  const known = new Set([
    ...names,
    ...Object.keys(defaults),
    ...Object.keys(condition?.overrides ?? {}),
    ...Object.keys(opts.legacy ?? {}),
  ]);
  const out: Record<string, FieldResolution> = {};
  for (const n of known) out[n] = resolveField(n, condition, defaults, opts);
  return out;
}

/** 供量纲引擎使用的解析结果（缺失字段保留空值，由引擎报“未赋值”，绝不取零） */
export function effectiveVariables(
  names: string[],
  condition: Condition | undefined,
  defaults: Record<string, FieldValue>,
  opts: ResolveOptions = {},
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const n of names) out[n] = resolveField(n, condition, defaults, opts);
  return out;
}

// ---------- 覆盖写入（含量纲校验，不合法直接拒绝） ----------

export class ConditionValidationError extends Error {}

/** 在某工况上写入/修改一个覆盖字段；返回修订后的新工况（不可变更新，rev + 1） */
export function setOverride(
  condition: Condition,
  name: string,
  patch: Partial<FieldValue>,
  defaults: Record<string, FieldValue>,
  now = Date.now(),
): Condition {
  if (condition.deleted) throw new ConditionValidationError("该工况已删除，不能继续编辑（请先恢复）");
  const prev = condition.overrides[name] ?? defaults[name] ?? { value: "", unit: "" };
  const next = normalizeField({ ...prev, ...patch });

  // 量纲校验：覆盖单位必须与公共默认同量纲（或双方都是纯数）
  const def = defaults[name];
  if (def !== undefined) {
    const err = unitCompatibilityError(next.unit, def.unit);
    if (err) throw new ConditionValidationError(`工况“${condition.name}”中变量 ${name}：${err}，已拒绝写入`);
  } else {
    const parseErr = unitParseError(next.unit);
    if (parseErr) throw new ConditionValidationError(`工况“${condition.name}”中变量 ${name}：${parseErr}，已拒绝写入`);
  }

  const overrides = { ...condition.overrides };
  const overrideRevs = { ...condition.overrideRevs };
  if (isEmpty(next) && def === undefined) {
    delete overrides[name];
    delete overrideRevs[name];
  } else {
    overrides[name] = next;
    if (overrideRevs[name] === undefined) overrideRevs[name] = condition.rev + 1;
  }
  return { ...condition, overrides, overrideRevs, rev: condition.rev + 1, updatedAt: now };
}

/** 取消覆盖：该字段恢复继承公共默认（rev + 1，历史仍可通过快照追溯） */
export function resetOverride(condition: Condition, name: string, now = Date.now()): Condition {
  if (!(name in condition.overrides)) return condition;
  const overrides = { ...condition.overrides };
  const overrideRevs = { ...condition.overrideRevs };
  delete overrides[name];
  delete overrideRevs[name];
  return { ...condition, overrides, overrideRevs, rev: condition.rev + 1, updatedAt: now };
}

/** 写公共默认变量。返回错误信息数组：与哪些工况的现存覆盖量纲不再兼容（不阻断写入，但明确告知） */
export function setDefault(
  nb: Notebook,
  name: string,
  patch: Partial<FieldValue>,
  now = Date.now(),
): { notebook: Notebook; warnings: string[] } {
  const prev = nb.defaults[name] ?? { value: "", unit: "" };
  const next = normalizeField({ ...prev, ...patch });
  const parseErr = unitParseError(next.unit);
  if (parseErr) throw new ConditionValidationError(`公共变量 ${name}：${parseErr}，已拒绝写入`);

  const defaults = { ...nb.defaults };
  if (isEmpty(next) && !(name in nb.defaults)) {
    // 显式新建的空占位行也保留（引擎仍会报“未赋值”，不会取零）；删除走 removeDefault
    defaults[name] = next;
  } else if (isEmpty(next)) {
    delete defaults[name];
  } else {
    defaults[name] = next;
  }

  // 单位量纲变化后，哪些旧覆盖变得不兼容（绝不静默改动它们，只给出冲突原因）
  const warnings: string[] = [];
  if (prev.unit.trim() !== next.unit.trim()) {
    for (const c of nb.conditions) {
      if (c.deleted) continue;
      const ov = c.overrides[name];
      if (ov !== undefined) {
        const err = isEmpty(next) ? null : unitCompatibilityError(ov.unit, next.unit);
        if (err) warnings.push(`工况“${c.name}”中 ${name} 的覆盖单位 ${ov.unit || "（纯数）"}：${err}`);
      }
    }
  }
  return {
    notebook: { ...nb, defaults, defaultsRev: nb.defaultsRev + 1, updatedAt: now },
    warnings,
  };
}

export function renameCondition(condition: Condition, name: string, now = Date.now()): Condition {
  const trimmed = name.trim();
  if (!trimmed) throw new ConditionValidationError("工况名称不能为空");
  return { ...condition, name: trimmed, rev: condition.rev + 1, updatedAt: now };
}

// ---------- 软删除 / 恢复（绝不污染其他工况，历史快照可继续说明） ----------

export function softDeleteCondition(condition: Condition, now = Date.now()): Condition {
  return { ...condition, deleted: true, deletedAt: now, updatedAt: now };
}

export function restoreCondition(condition: Condition, now = Date.now()): Condition {
  const { deleted: _d, deletedAt: _t, ...rest } = condition;
  void _d; void _t;
  return { ...rest, rev: condition.rev + 1, updatedAt: now };
}

// ---------- 旧版笔记迁移 ----------

export interface MigrationResult {
  notebook: Notebook;
  /** 转换后的公式（变量被移入公共默认 / 遗留回退） */
  formulas: Formula[];
  /** 迁移说明（哪些变量在公式间取值不一致，被保留为各公式的遗留值） */
  notices: string[];
}

/**
 * 把没有工况概念的旧公式（variables 挂在每条公式上）迁移为：
 *  - 所有公式取值一致的变量 → 公共默认变量；
 *  - 取值不一致的变量 → 保留在各自公式的 legacyVariables 中（互不污染）；
 *  - 生成一个可追溯的“默认工况（旧笔记迁移）”。
 */
export function migrateLegacyFormulas(
  legacy: { id: string; latex: string; note: string; targetUnit: string; createdAt: number;
            variables?: Record<string, FieldValue> }[],
  now = Date.now(),
): MigrationResult {
  const nb = makeNotebook(now);
  const migrated = nb.conditions[0];
  migrated.id = MIGRATED_CONDITION_ID;
  migrated.name = "默认工况（旧笔记迁移）";
  migrated.description = "由无工况概念的旧版笔记自动生成";
  nb.activeConditionId = MIGRATED_CONDITION_ID;

  const notices: string[] = [];
  const defs: Record<string, FieldValue> = {};
  const perFormula: Record<string, Record<string, FieldValue>> = {};

  // 收集每个变量在各公式中的取值
  const seen = new Map<string, { first: FieldValue; same: boolean; holders: string[] }>();
  legacy.forEach((f) => {
    perFormula[f.id] = {};
    for (const [k, v] of Object.entries(f.variables ?? {})) {
      const fv = normalizeField(v);
      if (isEmpty(fv)) continue;
      perFormula[f.id][k] = fv;
      const rec = seen.get(k);
      if (!rec) seen.set(k, { first: fv, same: true, holders: [f.id] });
      else if (!fieldsEqual(rec.first, fv)) { rec.same = false; rec.holders.push(f.id); }
    }
  });

  for (const [name, rec] of seen) {
    if (rec.same) defs[name] = rec.first;
    else notices.push(`变量 ${name} 在旧笔记各公式中取值不同，已分别保留为各公式的遗留值（互不影响）`);
  }
  nb.defaults = defs;

  const formulas: Formula[] = legacy.map((f) => {
    const legacyVariables = perFormula[f.id];
    const out: Formula = {
      id: f.id, latex: f.latex, note: f.note,
      targetUnit: f.targetUnit, createdAt: f.createdAt,
    };
    // 仅保留“取值不一致”的部分作为该公式的私有遗留回退
    const priv: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(legacyVariables)) {
      if (!(k in defs)) priv[k] = v;
    }
    if (Object.keys(priv).length) out.legacyVariables = priv;
    return out;
  });

  return { notebook: nb, formulas, notices };
}

// ---------- 多标签页修订冲突：三方合并 ----------

export interface FieldConflict {
  field: string;
  base: FieldValue | undefined;
  local: FieldValue | undefined;
  remote: FieldValue | undefined;
}

export interface MergeOutcome {
  /** 自动字段级合并后的覆盖表（不含未决冲突字段） */
  overrides: Record<string, FieldValue>;
  overrideRevs: Record<string, number>;
  /** 自动合并的字段（两标签页改的是不同字段） */
  autoMerged: string[];
  /** 必须人工选择的同字段冲突（绝不静默覆盖任一方） */
  conflicts: FieldConflict[];
  /** 名称是否也发生冲突 */
  nameConflict: { local: string; remote: string } | null;
  /** 无名称冲突时应采用的名称（远端改则取远端，本地改则取本地，双方相同则原样） */
  mergedName: string;
}

type OvState = {
  overrides: Record<string, FieldValue>;
  overrideRevs: Record<string, number>;
  name: string;
};

/**
 * 三方合并：base = 本标签页最后同步到的版本，local = 本地待保存，remote = 另一标签页已保存版本。
 * 不同字段的修改自动合并；同一字段双方都改且不同 → 冲突，交由用户逐字段选择。
 */
export function mergeConditionEdits(
  base: OvState,
  local: OvState,
  remote: OvState,
): MergeOutcome {
  const keys = new Set([
    ...Object.keys(base.overrides), ...Object.keys(local.overrides), ...Object.keys(remote.overrides),
  ]);
  const overrides: Record<string, FieldValue> = {};
  const overrideRevs: Record<string, number> = {};
  const autoMerged: string[] = [];
  const conflicts: FieldConflict[] = [];

  for (const key of keys) {
    const b = base.overrides[key];
    const l = local.overrides[key];
    const r = remote.overrides[key];
    const put = (f: FieldValue | undefined) => {
      if (f !== undefined) {
        overrides[key] = f;
        overrideRevs[key] = Math.max(
          base.overrideRevs[key] ?? 0, local.overrideRevs[key] ?? 0, remote.overrideRevs[key] ?? 0,
        );
      }
    };

    if (fieldsEqual(l, r)) {
      put(l); // 双方一致（含同时删除）
    } else if (fieldsEqual(l, b)) {
      put(r); // 只有远端改了
      if (!fieldsEqual(r, b)) autoMerged.push(key);
    } else if (fieldsEqual(r, b)) {
      put(l); // 只有本地改了
      if (!fieldsEqual(l, b)) autoMerged.push(key);
    } else {
      // 双方都改且不同：冲突，不挑任一方，保留双方值待人工裁决
      conflicts.push({ field: key, base: b, local: l, remote: r });
      put(l); // 暂存本地值到编辑区，但在冲突解决前不允许保存
    }
  }

  let nameConflict: MergeOutcome["nameConflict"] = null;
  let mergedName = local.name;
  if (local.name !== remote.name) {
    if (local.name !== base.name && remote.name !== base.name) {
      nameConflict = { local: local.name, remote: remote.name };
    } else if (local.name === base.name) {
      mergedName = remote.name; // 只有远端改名
    } else {
      mergedName = local.name;  // 只有本地改名
    }
  }

  return { overrides, overrideRevs, autoMerged, conflicts, nameConflict, mergedName };
}

/** 公共默认变量层的三方合并（按字段合并 value/unit 两个子项） */
export function mergeDefaultsEdits(
  base: Record<string, FieldValue>,
  local: Record<string, FieldValue>,
  remote: Record<string, FieldValue>,
): { merged: Record<string, FieldValue>; conflicts: FieldConflict[]; autoMerged: string[] } {
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const merged: Record<string, FieldValue> = {};
  const conflicts: FieldConflict[] = [];
  const autoMerged: string[] = [];
  for (const key of keys) {
    const b = base[key];
    const l = local[key];
    const r = remote[key];
    if (fieldsEqual(l, r)) { if (l) merged[key] = l; }
    else if (fieldsEqual(l, b)) { if (r) merged[key] = r; if (!fieldsEqual(r, b)) autoMerged.push(key); }
    else if (fieldsEqual(r, b)) { if (l) merged[key] = l; if (!fieldsEqual(l, b)) autoMerged.push(key); }
    else conflicts.push({ field: key, base: b, local: l, remote: r });
  }
  return { merged, conflicts, autoMerged };
}
