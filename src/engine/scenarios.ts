// 参数工况集：纯逻辑（不碰 IndexedDB / DOM，便于单测）
//
// 分层取值优先级（逐字段）：
//   工况覆盖（scenario.variables[name].value/unit）
//   > 公共默认（defaults.variables[name].value/unit）
//   > 旧版自带（formula.legacyVariables[name].value/unit，仅迁移公式）
//   > 缺值（missing：引擎报“未赋值”，绝不取零）
//
// 多标签页并发：每个文档带 rev（修订号）。保存采用 CAS——
// 本地基于 baseRev 编辑，写入时若库中 rev 已前进则拒绝整次写入，
// 由调用方做字段级三方合并（base/local/remote），冲突字段绝不静默覆盖。

import { create, all, type MathJsInstance } from "mathjs";
import type {
  FieldConflict, FieldKey, Formula, PublicDefaultsDoc,
  ResolvedField, ResolvedVar, Scenario, ScenarioVar, VariableDef,
} from "./types";

const math: MathJsInstance = create(all);

export const DEFAULT_SCENARIO_ID = "scn_default";
const HISTORY_CAP = 50;

export function newScenarioId(): string {
  return `scn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeScenario(name: string, now = Date.now()): Scenario {
  return {
    id: newScenarioId(),
    name,
    rev: 1,
    variables: {},
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 内置“常温”默认工况，id 固定，旧数据迁移时复用它 */
export function makeDefaultScenario(now = Date.now()): Scenario {
  return { ...makeScenario("常温", now), id: DEFAULT_SCENARIO_ID, origin: "内置默认工况" };
}

export function makeDefaults(variables: Record<string, VariableDef> = {}, now = Date.now()): PublicDefaultsDoc {
  return { id: "defaults", variables, rev: 1, updatedAt: now, history: [] };
}

// ---------- 字段解析 ----------

/** 用 mathjs 判断两个单位文本的量纲是否兼容（空串 = 无量纲纯数）；无法识别返回 null */
export function unitsDimensionCompatible(a: string, b: string): boolean | null {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta && !tb) return true;
  try {
    if (!ta) { math.unit(tb); return false; }
    if (!tb) { math.unit(ta); return false; }
    const ua = math.unit(ta);
    const ub = math.unit(tb);
    return ua.equalBase(ub);
  } catch {
    return null; // 至少一方单位无法识别：不做断言
  }
}

function resolveField(
  scn: ScenarioVar | undefined,
  pub: VariableDef | undefined,
  legacy: VariableDef | undefined,
  field: FieldKey,
): ResolvedField {
  const has = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
  const out: ResolvedField = { text: "", source: "missing", overridden: false };

  if (has(scn?.[field])) {
    out.text = scn![field]!;
    out.source = "scenario";
    out.overridden = true;
  } else if (has(legacy?.[field])) {
    // 旧版（无工况）迁移公式：公式自带赋值优先于公共默认，
    // 保证旧公式永远按保存当时的值计算（公共默认后来被别的公式/教师改掉也不影响它）。
    out.text = legacy![field];
    out.source = "legacy";
  } else if (has(pub?.[field])) {
    out.text = pub![field];
    out.source = "default";
  }

  // 覆盖单位与公共默认同字段的量纲交叉检查：值字段不查，单位字段查
  if (field === "unit" && out.overridden && has(pub?.unit)) {
    const ok = unitsDimensionCompatible(out.text, pub!.unit);
    if (ok === false) {
      out.dimNote = `覆盖单位“${out.text}”与公共默认单位“${pub!.unit}”量纲不兼容，公式可能报量纲错误`;
    }
  }
  return out;
}

/** 解析单个变量在指定工况下的有效 value/unit 及来源 */
export function resolveVariable(
  name: string,
  scenario: Scenario | undefined,
  defaults: PublicDefaultsDoc,
  legacy?: Record<string, VariableDef>,
): ResolvedVar {
  const scn = scenario?.variables[name];
  const pub = defaults.variables[name];
  const leg = legacy?.[name];
  const value = resolveField(scn, pub, leg, "value");
  const unit = resolveField(scn, pub, leg, "unit");
  return { value, unit, legacy: value.source === "legacy" || unit.source === "legacy" };
}

/**
 * 解析公式在某工况下参与计算的完整变量表（Record<name, VariableDef>），
 * 同时返回逐字段来源与单位量纲提示。公式引用的变量优先，另保留曾赋值的变量。
 */
export function resolveFormulaVars(
  formula: Formula,
  varNames: string[],
  scenario: Scenario | undefined,
  defaults: PublicDefaultsDoc,
): { defs: Record<string, VariableDef>; resolved: Record<string, ResolvedVar> } {
  const names = new Set<string>(varNames);
  Object.keys(defaults.variables).forEach((n) => names.add(n));
  Object.keys(scenario?.variables ?? {}).forEach((n) => names.add(n));
  Object.keys(formula.legacyVariables ?? {}).forEach((n) => names.add(n));

  const defs: Record<string, VariableDef> = {};
  const resolved: Record<string, ResolvedVar> = {};
  for (const name of names) {
    const r = resolveVariable(name, scenario, defaults, formula.legacyVariables);
    resolved[name] = r;
    // 缺值也写入空串（与旧 VariableTable 语义一致），引擎据此报“未赋值”，不会取零
    defs[name] = { value: r.value.text, unit: r.unit.text };
  }
  return { defs, resolved };
}

// ---------- 覆盖编辑 ----------

/** 设置某字段为覆盖值（空串 = 清除该字段覆盖，恢复继承） */
export function setScenarioField(
  scenario: Scenario,
  name: string,
  field: FieldKey,
  text: string,
): Scenario {
  const variables = structuredClone(scenario.variables);
  const cur: ScenarioVar = variables[name] ? { ...variables[name] } : {};
  const t = text ?? "";
  if (t.trim() === "") delete cur[field];
  else cur[field] = t;
  if (Object.keys(cur).length === 0) delete variables[name];
  else variables[name] = cur;
  return { ...scenario, variables, updatedAt: Date.now() };
}

/** 判定某字段当前是否被覆盖 */
export function isOverridden(scenario: Scenario, name: string, field: FieldKey): boolean {
  const v = scenario.variables[name]?.[field];
  return v !== undefined && v.trim() !== "";
}

// ---------- 修订历史 ----------

export function pushHistory(
  history: Scenario["history"],
  entry: Omit<(Scenario["history"])[number], "rev"> & { rev: number },
): Scenario["history"] {
  return [entry, ...history].slice(0, HISTORY_CAP);
}

/** 在本地草稿上产生下一版工况（仅在 CAS 成功后调用） */
export function commitScenario(
  scenario: Scenario,
  variables: Record<string, ScenarioVar>,
  rev: number,
  tabId: string,
  note: string,
  now = Date.now(),
): Scenario {
  const history = pushHistory(scenario.history, {
    rev, at: now, tabId, note, variables: structuredClone(variables),
  });
  return { ...scenario, rev, variables: structuredClone(variables), history, updatedAt: now };
}

export function commitDefaults(
  doc: PublicDefaultsDoc,
  variables: Record<string, VariableDef>,
  rev: number,
  tabId: string,
  note: string,
  now = Date.now(),
): PublicDefaultsDoc {
  const history = pushHistory(doc.history, {
    rev, at: now, tabId, note,
    variables: structuredClone(variables) as Record<string, ScenarioVar>,
  });
  return { ...doc, rev, variables: structuredClone(variables), history, updatedAt: now };
}

// ---------- 字段级三方合并 ----------

const fieldVal = (vars: Record<string, ScenarioVar> | undefined, name: string, field: FieldKey): string | undefined =>
  vars?.[name]?.[field];

/** 找出 base→local 与 base→remote 都改了同一字段、且新值不同的冲突 */
export function findFieldConflicts(
  base: Record<string, ScenarioVar>,
  local: Record<string, ScenarioVar>,
  remote: Record<string, ScenarioVar>,
): FieldConflict[] {
  const names = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  const conflicts: FieldConflict[] = [];
  for (const name of names) {
    for (const field of ["value", "unit"] as FieldKey[]) {
      const b = fieldVal(base, name, field);
      const l = fieldVal(local, name, field);
      const r = fieldVal(remote, name, field);
      const localChanged = (l ?? "") !== (b ?? "");
      const remoteChanged = (r ?? "") !== (b ?? "");
      if (localChanged && remoteChanged && (l ?? "") !== (r ?? "")) {
        conflicts.push({ varName: name, field, base: b, local: l, remote: r });
      }
    }
  }
  return conflicts;
}

/**
 * 字段级合并：
 *  - 只有一方修改的字段自动采用该方；
 *  - 双方都改但改后相同，任取；
 *  - 双方改成不同值 = 冲突：默认保留远端值（已入库的对端成果不丢），
 *    本地值随冲突事件原样保留，由用户在界面上逐字段选择。
 * 返回合并表 + 冲突清单（无冲突即可安全保存）。
 */
export function mergeFields(
  base: Record<string, ScenarioVar>,
  local: Record<string, ScenarioVar>,
  remote: Record<string, ScenarioVar>,
): { merged: Record<string, ScenarioVar>; conflicts: FieldConflict[] } {
  const conflicts = findFieldConflicts(base, local, remote);
  const merged: Record<string, ScenarioVar> = {};
  const names = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const name of names) {
    const entry: ScenarioVar = {};
    for (const field of ["value", "unit"] as FieldKey[]) {
      const b = fieldVal(base, name, field);
      const l = fieldVal(local, name, field);
      const r = fieldVal(remote, name, field);
      let v: string | undefined;
      const localChanged = (l ?? "") !== (b ?? "");
      const remoteChanged = (r ?? "") !== (b ?? "");
      if (localChanged && remoteChanged) {
        v = (l ?? "") === (r ?? "") ? l : r; // 真冲突时先取远端（不静默：见 conflicts）
      } else if (localChanged) {
        v = l;
      } else if (remoteChanged) {
        v = r;
      } else {
        v = b;
      }
      if (v !== undefined && v.trim() !== "") entry[field] = v;
    }
    if (Object.keys(entry).length) merged[name] = entry;
  }
  return { merged, conflicts };
}

/** 用户在冲突面板逐字段决定后，用所选值覆盖合并表中的冲突字段 */
export function resolveConflictField(
  merged: Record<string, ScenarioVar>,
  c: FieldConflict,
  pick: "local" | "remote",
): Record<string, ScenarioVar> {
  const next = structuredClone(merged);
  const chosen = pick === "local" ? c.local : c.remote;
  const cur: ScenarioVar = next[c.varName] ? { ...next[c.varName] } : {};
  if (chosen === undefined || chosen.trim() === "") delete cur[c.field];
  else cur[c.field] = chosen;
  if (Object.keys(cur).length === 0) delete next[c.varName];
  else next[c.varName] = cur;
  return next;
}

/** 归一化外部读入的覆盖表（只保留 value/unit 字符串） */
export function sanitizeScenarioVars(raw: unknown): Record<string, ScenarioVar> {
  const out: Record<string, ScenarioVar> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const entry: ScenarioVar = {};
    if (typeof o.value === "string" && o.value.trim() !== "") entry.value = o.value;
    if (typeof o.unit === "string" && o.unit.trim() !== "") entry.unit = o.unit;
    if (Object.keys(entry).length) out[k] = entry;
  }
  return out;
}

export function sanitizeVarDefs(raw: unknown): Record<string, VariableDef> {
  const out: Record<string, VariableDef> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    out[k] = { value: String(o.value ?? ""), unit: String(o.unit ?? "") };
  }
  return out;
}
