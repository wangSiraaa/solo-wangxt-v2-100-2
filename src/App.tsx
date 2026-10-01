import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CalcSnapshot, Condition, FieldResolution, FieldValue, Formula, Notebook,
} from "./engine/types";
import {
  DEFAULT_CONDITION_ID, ConditionValidationError, activeCondition, collectFormulaVarNames,
  conditionUsable, makeCondition, makeNotebook, mergeConditionEdits,
  mergeDefaultsEdits, migrateLegacyFormulas, normalizeField, renameCondition,
  resetOverride, resolveField, restoreCondition, setDefault, setOverride, softDeleteCondition,
} from "./engine/conditions";
import { buildSnapshot, snapshotFingerprint } from "./engine/snapshot";
import {
  RevisionConflict, db, newId, subscribeChanges, type LegacyFormulaRow,
} from "./storage/db";
import { buildExport, downloadJSON, parseImport } from "./storage/exchange";
import FormulaCard from "./components/FormulaCard";
import ConditionsBar from "./components/ConditionsBar";
import DefaultsEditor from "./components/DefaultsEditor";
import ConflictDialog, { type PendingConflict } from "./components/ConflictDialog";

function makeFormula(partial?: Partial<Formula>): Formula {
  return {
    id: newId(),
    latex: "",
    note: "",
    targetUnit: "",
    createdAt: Date.now(),
    ...partial,
  };
}

/** 从 IndexedDB v1 行（变量挂在公式上）抽取迁移输入 */
function legacyRowToInput(row: LegacyFormulaRow) {
  const vars: Record<string, FieldValue> = {};
  const raw = row.variables;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const vv = v as Partial<FieldValue>;
      if (vv && typeof vv === "object") vars[k] = normalizeField(vv);
    }
  }
  return {
    id: row.id, latex: row.latex ?? "", note: row.note ?? "",
    targetUnit: row.targetUnit ?? "", createdAt: row.createdAt ?? Date.now(), variables: vars,
  };
}

const isLegacyRow = (f: Formula | LegacyFormulaRow): f is LegacyFormulaRow =>
  "variables" in f && f.variables !== undefined;

export default function App() {
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, CalcSnapshot[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const [defaultsWarnings, setDefaultsWarnings] = useState<string[]>([]);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 最后一次与数据库同步的笔记（三方合并 base）；localRef 始终指向最新本地笔记
  const baseRef = useRef<Notebook | null>(null);
  const notebookRef = useRef<Notebook | null>(null);
  notebookRef.current = notebook;

  // ---------- 启动：加载 + v1 迁移 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let nb = await db.getNotebook();
        const rows = await db.allFormulas();
        const legacyRows = rows.filter(isLegacyRow) as LegacyFormulaRow[];
        let formulasOut: Formula[];

        if (!nb) {
          if (legacyRows.length > 0) {
            // 旧版（无工况概念）本地笔记 → 迁移出可追溯默认工况
            const mig = migrateLegacyFormulas(legacyRows.map(legacyRowToInput));
            nb = mig.notebook;
            formulasOut = mig.formulas;
            await db.putNotebook(nb);
            await db.bulkPutFormulas(formulasOut, true);
            setNotice(`已从旧版自动迁移：${mig.notices.length ? mig.notices.join("；") : "生成可追溯默认工况"}`);
          } else {
            nb = makeNotebook();
            await db.putNotebook(nb);
            formulasOut = [];
          }
        } else {
          formulasOut = rows.filter((r): r is Formula => !isLegacyRow(r));
          // 极端情况下残留的 v1 行也迁移一次（不覆盖已有工况）
          if (legacyRows.length > 0) {
            const mig = migrateLegacyFormulas(legacyRows.map(legacyRowToInput));
            await db.bulkPutFormulas(mig.formulas, true);
            formulasOut = [...formulasOut, ...mig.formulas].sort((a, b) => a.createdAt - b.createdAt);
          }
          if (!nb.conditions.some((c) => c.id === DEFAULT_CONDITION_ID || !c.deleted)) {
            nb = { ...nb, conditions: [...nb.conditions, makeConditionDefaultFallback()], activeConditionId: nb.activeConditionId ?? DEFAULT_CONDITION_ID };
            await db.putNotebook(nb);
          }
        }

        if (cancelled) return;
        baseRef.current = nb;
        setNotebook(nb);
        setFormulas(formulasOut);
        const allSnaps = await db.allSnapshots();
        setSnapshots(groupByFormula(allSnaps));
        void db.pruneSnapshots(20);
      } catch (e) {
        if (!cancelled) setNotice(`读取本地存储失败：${(e as Error).message}`);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---------- 公式变更防抖写入（公式之间独立，不做修订并发） ----------
  const formulaTimer = useRef<number | undefined>(undefined);
  const formulaDirtyRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    formulaDirtyRef.current = true;
    window.clearTimeout(formulaTimer.current);
    formulaTimer.current = window.setTimeout(() => {
      db.bulkPutFormulas(formulas).then(() => { formulaDirtyRef.current = false; })
        .catch((e) => setNotice(`保存失败：${(e as Error).message}`));
    }, 300);
  }, [formulas, loaded]);

  // ---------- 工况笔记：本地更新 + 防抖带修订号保存 ----------
  const saveTimer = useRef<number | undefined>(undefined);
  const conflictRef = useRef<PendingConflict | null>(null);
  conflictRef.current = conflict;

  // 待保存笔记的最新版本（连续快速编辑时防抖只落最后一次；乐观锁取“已同步”的最新修订号）
  const pendingSaveRef = useRef<{ next: Notebook; conditionId?: string; isDefaults?: boolean } | null>(null);

  const persistNotebook = useCallback((next: Notebook, _base: Notebook, opts?: {
    conditionId?: string;
    isDefaults?: boolean;
  }) => {
    pendingSaveRef.current = { next, conditionId: opts?.conditionId, isDefaults: opts?.isDefaults };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const pending = pendingSaveRef.current;
      if (!pending) return;
      // 始终基于最近一次成功同步的修订号做乐观锁，避免连续快速编辑用旧 base 误报冲突
      const synced = baseRef.current;
      if (!synced) return;
      const targetConditionId = pending.conditionId ?? pending.next.activeConditionId ?? "";
      const expected = pending.isDefaults
        ? { defaultsRev: synced.defaultsRev }
        : { conditionRevs: { [targetConditionId]:
            synced.conditions.find((c) => c.id === targetConditionId)?.rev ?? 0 } };
      db.updateNotebook(() => pending.next, expected).then((saved) => {
        baseRef.current = saved;
        pendingSaveRef.current = null;
      }).catch((e) => {
        if (e instanceof RevisionConflict) {
          handleRevisionConflict(pending.next, synced, e.fresh, {
            conditionId: pending.conditionId, isDefaults: pending.isDefaults,
          });
        } else {
          setNotice(`工况保存失败：${(e as Error).message}`);
        }
      });
    }, 250);
  }, []);

  // 三方合并：不同字段自动合并；同字段双方都改 → 弹窗逐字段选择
  const handleRevisionConflict = useCallback((
    local: Notebook,
    base: Notebook,
    remote: Notebook,
    opts?: { conditionId?: string; isDefaults?: boolean },
  ) => {
    if (opts?.isDefaults) {
      const m = mergeDefaultsEdits(base.defaults, local.defaults, remote.defaults);
      if (m.conflicts.length === 0) {
        const merged: Notebook = {
          ...local, defaults: m.merged, defaultsRev: remote.defaultsRev,
          conditions: remote.conditions,
          updatedAt: Date.now(),
        };
        setNotebook(merged);
        db.updateNotebook(() => merged, { defaultsRev: remote.defaultsRev })
          .then((saved) => { baseRef.current = saved; })
          .catch((e2) => { if (!(e2 instanceof RevisionConflict)) setNotice(`工况保存失败：${(e2 as Error).message}`); });
        setNotice(`已与另一标签页字段级合并（默认变量：${m.autoMerged.join("、") || "无冲突字段"}）`);
        return;
      }
      setConflict({
        targetId: "__defaults__",
        targetName: "公共默认变量层",
        conflicts: m.conflicts,
        autoMerged: m.autoMerged,
        remoteMerged: m.merged,
      });
      return;
    }

    const cid = opts?.conditionId ?? local.activeConditionId ?? "";
    const lc = local.conditions.find((c) => c.id === cid);
    const bc = base.conditions.find((c) => c.id === cid);
    const rc = remote.conditions.find((c) => c.id === cid);
    if (!lc || !bc || !rc) {
      // 工况在远端被删除：明确提示，绝不静默覆盖恢复
      setNotice(`工况可能已被另一标签页删除，本次保存已中止（请刷新查看，不会覆盖对方的删除）`);
      return;
    }
    const m = mergeConditionEdits(
      { overrides: bc.overrides, overrideRevs: bc.overrideRevs, name: bc.name },
      { overrides: lc.overrides, overrideRevs: lc.overrideRevs, name: lc.name },
      { overrides: rc.overrides, overrideRevs: rc.overrideRevs, name: rc.name },
    );
    if (m.conflicts.length === 0 && !m.nameConflict) {
      // 公共默认层也做一次三方合并（本标签页可能同时改过默认值）；冲突则保守取本地并提示
      const dm = mergeDefaultsEdits(base.defaults, local.defaults, remote.defaults);
      // 其他工况采用远端较新版本；仅目标工况用字段级合并结果
      const conditions = remote.conditions.map((c) =>
        c.id === cid
          ? { ...c, name: m.mergedName, overrides: m.overrides, overrideRevs: m.overrideRevs,
              rev: rc.rev + 1, updatedAt: Date.now() }
          : c);
      const merged: Notebook = {
        ...local,
        defaults: dm.conflicts.length ? local.defaults : dm.merged,
        defaultsRev: remote.defaultsRev,
        conditions,
      };
      setNotebook(merged);
      db.updateNotebook(() => merged, { conditionRevs: { [cid]: rc.rev } })
        .then((saved) => { baseRef.current = saved; })
        .catch((e2) => { if (!(e2 instanceof RevisionConflict)) setNotice(`工况保存失败：${(e2 as Error).message}`); });
      setNotice(`已与另一标签页字段级合并（自动合并字段：${m.autoMerged.join("、") || "双方一致"}）`);
      if (dm.conflicts.length) setNotice("注意：公共默认层也存在双方修改，已保留你的本地值，请检查后再保存");
      return;
    }
    setConflict({
      targetId: cid,
      targetName: `工况“${lc.name}”`,
      conflicts: m.conflicts,
      autoMerged: m.autoMerged,
      remoteMerged: m.overrides,
      nameConflict: m.nameConflict,
    });
  }, []);

  /** 冲突对话框中人工裁决后，按选择保存 */
  const resolveConflict = useCallback((resolution: Record<string, FieldValue>, nameChoice?: { use: "local" | "remote" } | null) => {
    const local = notebookRef.current;
    const base = baseRef.current;
    const pending = conflictRef.current;
    if (!local || !base || !pending) return;
    void (async () => {
      const remote = await db.getNotebook();
      if (!remote) return;
      if (pending.targetId === "__defaults__") {
        const next: Notebook = {
          ...local, defaults: resolution, defaultsRev: remote.defaultsRev, updatedAt: Date.now(),
        };
        const saved = await db.updateNotebook(() => next, { defaultsRev: remote.defaultsRev });
        baseRef.current = saved; setNotebook(saved);
      } else {
        const cid = pending.targetId;
        const rc = remote.conditions.find((c) => c.id === cid);
        if (!rc) { setNotice("该工况已被另一标签页删除，已放弃本次覆盖"); setConflict(null); return; }
        const conditions = local.conditions.map((c) => {
          if (c.id !== cid) return c;
          const name = pending.nameConflict && nameChoice
            ? (nameChoice.use === "local" ? c.name : rc.name) : c.name;
          return {
            ...c, name, overrides: resolution,
            overrideRevs: Object.fromEntries(Object.keys(resolution).map((k) => [
              k, Math.max(c.overrideRevs[k] ?? 0, rc.overrideRevs[k] ?? 0, base.conditions.find((x) => x.id === cid)!.overrideRevs[k] ?? 0) || rc.rev + 1,
            ])),
            rev: rc.rev + 1, updatedAt: Date.now(),
          };
        });
        const next: Notebook = { ...local, conditions };
        const saved = await db.updateNotebook(() => next, { conditionRevs: { [cid]: rc.rev } });
        baseRef.current = saved; setNotebook(saved);
      }
      setConflict(null);
      setNotice("冲突已按你的字段级选择合并保存，双方历史均已保留");
    })().catch((e) => {
      if (e instanceof RevisionConflict) setNotice("另一标签页又有新修改，请再次选择合并方式");
      else setNotice(`合并保存失败：${(e as Error).message}`);
    });
  }, []);

  // ---------- 跨标签页变更：远端改动则变基（无本地改动时直接采用） ----------
  useEffect(() => {
    if (!loaded) return;
    const unsub = subscribeChanges((kind) => {
      if (conflictRef.current) return; // 冲突待裁决期间不打断用户
      if (kind === "notebook") {
        db.getNotebook().then((remote) => {
          if (!remote) return;
          const local = notebookRef.current;
          const base = baseRef.current;
          if (!local || !base) return;
          const localDirty = local !== base;
          if (!localDirty) {
            baseRef.current = remote;
            setNotebook(remote);
          }
          // 本地有未保存改动时不抢先变基；下次保存会触发 RevisionConflict 走合并
        }).catch(() => undefined);
      } else if (kind === "formula") {
        // 本标签页刚做的本地编辑会通过防抖自行保存；远端变更时再拉取，避免互相覆盖输入
        if (formulaDirtyRef.current) return;
        db.allFormulas().then((rows) => {
          setFormulas(rows.filter((r): r is Formula => !isLegacyRow(r)));
        }).catch(() => undefined);
      } else if (kind === "snapshot") {
        db.allSnapshots().then((all) => setSnapshots(groupByFormula(all))).catch(() => undefined);
      }
    });
    return unsub;
  }, [loaded]);

  // ---------- 工况编辑操作 ----------
  const updateActiveCondition = useCallback((updater: (c: Condition) => Condition) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    const cid = nb.activeConditionId;
    const c = cid ? nb.conditions.find((x) => x.id === cid) : undefined;
    if (!c || c.deleted) { setNotice("当前没有可编辑的工况（可能已删除），请先选择或恢复工况"); return; }
    let next: Notebook;
    try {
      const updated = updater(c);
      next = {
        ...nb,
        conditions: nb.conditions.map((x) => (x.id === c.id ? updated : x)),
        updatedAt: Date.now(),
      };
    } catch (e) {
      if (e instanceof ConditionValidationError) { setNotice(e.message); return; }
      throw e;
    }
    setNotebook(next);
    persistNotebook(next, base, { conditionId: c.id });
  }, [persistNotebook]);

  const handleOverride = useCallback((name: string, patch: { value?: string; unit?: string }) => {
    const nb = notebookRef.current;
    if (!nb) return;
    updateActiveCondition((c) => setOverride(c, name, patch, nb.defaults));
  }, [updateActiveCondition]);

  const handleMakeOverride = useCallback((name: string) => {
    const nb = notebookRef.current;
    if (!nb) return;
    const c = activeCondition(nb);
    if (!c || c.deleted) return;
    if (name in c.overrides) return;
    const seed = nb.defaults[name] ?? { value: "", unit: "" };
    updateActiveCondition((x) => setOverride(x, name, { value: seed.value, unit: seed.unit }, nb.defaults));
  }, [updateActiveCondition]);

  const handleResetOverride = useCallback((name: string) => {
    updateActiveCondition((c) => resetOverride(c, name));
  }, [updateActiveCondition]);

  const handleDefaultChange = useCallback((name: string, patch: Partial<FieldValue>) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    let result: { notebook: Notebook; warnings: string[] };
    try {
      result = setDefault(nb, name, patch);
    } catch (e) {
      if (e instanceof ConditionValidationError) { setNotice(e.message); return; }
      throw e;
    }
    setNotebook(result.notebook);
    setDefaultsWarnings(result.warnings);
    persistNotebook(result.notebook, base, { isDefaults: true });
  }, [persistNotebook]);

  const handleDefaultRemove = useCallback((name: string) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    const result = setDefault(nb, name, { value: "", unit: "" });
    setNotebook(result.notebook);
    setDefaultsWarnings(result.warnings);
    persistNotebook(result.notebook, base, { isDefaults: true });
  }, [persistNotebook]);

  const switchCondition = useCallback((id: string) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    if (nb.activeConditionId === id) return;
    const next: Notebook = { ...nb, activeConditionId: id, updatedAt: Date.now() };
    setNotebook(next);
    // 选中项不属于任何工况修订；以默认层修订号做乐观锁即可
    persistNotebook(next, base, { isDefaults: true });
  }, [persistNotebook]);

  const createCondition = useCallback((name: string) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    const c = makeCondition(name);
    const next: Notebook = { ...nb, conditions: [...nb.conditions, c], activeConditionId: c.id, updatedAt: Date.now() };
    setNotebook(next);
    // 新建走默认层预期（不涉及已有工况修订冲突）
    persistNotebook(next, base, { isDefaults: true });
  }, [persistNotebook]);

  const renameActive = useCallback((id: string, name: string) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    const target = nb.conditions.find((c) => c.id === id);
    if (!target) return;
    let updated: Condition;
    try {
      updated = renameCondition(target, name);
    } catch (e) {
      if (e instanceof ConditionValidationError) { setNotice(e.message); return; }
      throw e;
    }
    const next: Notebook = { ...nb, conditions: nb.conditions.map((c) => (c.id === id ? updated : c)), updatedAt: Date.now() };
    setNotebook(next);
    persistNotebook(next, base, { conditionId: id });
  }, [persistNotebook]);

  const deleteCondition = useCallback((id: string) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    // 允许删除当前（甚至唯一一套）工况：公式只报“不可用/未赋值”，绝不回退零值；
    // 历史快照保留，且随时可恢复。
    const target = nb.conditions.find((c) => c.id === id);
    if (!target) return;
    const next: Notebook = {
      ...nb,
      conditions: nb.conditions.map((c) => (c.id === id ? softDeleteCondition(c) : c)),
      activeConditionId: nb.activeConditionId === id
        ? (nb.conditions.find((c) => !c.deleted && c.id !== id)?.id ?? null)
        : nb.activeConditionId,
      updatedAt: Date.now(),
    };
    setNotebook(next);
    persistNotebook(next, base, { conditionId: id });
    setNotice(`工况“${target.name}”已软删除：历史快照保留、可恢复；其他工况不受影响`);
  }, [persistNotebook]);

  const restoreCond = useCallback((id: string) => {
    const nb = notebookRef.current;
    const base = baseRef.current;
    if (!nb || !base) return;
    const next: Notebook = {
      ...nb,
      conditions: nb.conditions.map((c) => (c.id === id ? restoreCondition(c) : c)),
      activeConditionId: id,
      updatedAt: Date.now(),
    };
    setNotebook(next);
    persistNotebook(next, base, { conditionId: id });
  }, [persistNotebook]);

  // ---------- 公式增删改 ----------
  const updateFormula = useCallback((id: string, patch: Partial<Formula>) => {
    setFormulas((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const removeFormula = useCallback(async (id: string) => {
    setFormulas((fs) => fs.filter((f) => f.id !== id));
    await db.deleteFormula(id).catch(() => undefined);
  }, []);

  const add = () => setFormulas((fs) => [...fs, makeFormula()]);

  // 示例沿用自包含的旧版遗留变量，保证独立演示且不污染工况
  const addExample = (kind: "unit" | "degC" | "angle" | "dimErr" | "divZero" | "speed") => {
    const presets: Record<string, Formula> = {
      unit: makeFormula({
        latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
        note: "匀变速直线运动位移",
        targetUnit: "m",
        legacyVariables: {
          v: { value: "2", unit: "m/s" },
          t: { value: "3", unit: "s" },
          a: { value: "4", unit: "m/s^2" },
        },
      }),
      speed: makeFormula({
        latex: "\\frac{s}{t}",
        note: "平均速度：常温 vs 满载（示例变量请在工况中维护，此处仅演示公式）",
        targetUnit: "km/h",
      }),
      degC: makeFormula({
        latex: "T_1+T_2",
        note: "摄氏度直接相加 —— 应提示偏移温标歧义并标记未验证",
        targetUnit: "",
        legacyVariables: { T_1: { value: "10", unit: "degC" }, T_2: { value: "5", unit: "degC" } },
      }),
      angle: makeFormula({
        latex: "\\theta+\\alpha",
        note: "度与弧度相加 —— 量纲兼容，自动换算",
        targetUnit: "deg",
        legacyVariables: { theta: { value: "1", unit: "rad" }, alpha: { value: "180", unit: "deg" } },
      }),
      dimErr: makeFormula({
        latex: "(a+b)\\cdot c",
        note: "m 与 kg 相加 —— 应定位到括号内的 + 节点",
        targetUnit: "",
        legacyVariables: {
          a: { value: "1", unit: "m" }, b: { value: "2", unit: "kg" }, c: { value: "3", unit: "" },
        },
      }),
      divZero: makeFormula({
        latex: "x/y",
        note: "除零 —— 必须明确报错，不产生 Infinity",
        targetUnit: "",
        legacyVariables: { x: { value: "10", unit: "m" }, y: { value: "0", unit: "s" } },
      }),
    };
    setFormulas((fs) => [...fs, presets[kind]]);
  };

  // ---------- 快照：稳定后冻结“当时工况/版本/变量” ----------
  const resolvedByFormula = useMemo(() => {
    const map: Record<string, Record<string, FieldResolution>> = {};
    if (!notebook) return map;
    const cond = activeCondition(notebook);
    for (const f of formulas) {
      map[f.id] = resolveForFormula(f, notebook, cond);
    }
    return map;
  }, [formulas, notebook]);

  const snapTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!loaded || !notebook) return;
    window.clearTimeout(snapTimer.current);
    snapTimer.current = window.setTimeout(() => {
      const cond = activeCondition(notebook);
      // 当前工况缺失或已软删除：不计算、不生成新快照、绝不回退零值（历史快照仍可查看）
      if (!cond || cond.deleted) return;
      const candidates: CalcSnapshot[] = [];
      for (const f of formulas) {
        const resolved = resolveForFormula(f, notebook, cond);
        const snap = buildSnapshot({ formula: f, condition: cond, notebook, resolved });
        if (!snap) continue;
        const existing = snapshots[f.id] ?? [];
        if (existing.some((s) => snapshotFingerprint(s) === snapshotFingerprint(snap))) continue;
        candidates.push(snap);
      }
      if (!candidates.length) return;
      void db.bulkPutSnapshots(candidates).then(() => {
        setSnapshots((prev) => {
          const next = { ...prev };
          for (const s of candidates) {
            next[s.formulaId] = [s, ...(next[s.formulaId] ?? [])];
          }
          return next;
        });
        void db.pruneSnapshots(20);
      });
    }, 900);
  }, [resolvedByFormula, loaded, notebook, formulas, snapshots]);

  // ---------- 导出 / 导入 ----------

  // 端到端测试钩子：在不打开第二个浏览器标签页的情况下，确定性地模拟
  // “另一标签页直接向 IndexedDB 保存了工况修订”，用于验证修订冲突与字段级合并。
  useEffect(() => {
    if (!loaded) return;
    const w = window as unknown as { __dnTest?: Record<string, unknown> };
    w.__dnTest = {
      /** 读取当前库中工况笔记 */
      getRemote: () => db.getNotebook(),
      /** 模拟另一标签页在指定工况上直接保存字段（修订号 +1），并广播变更 */
      remoteSaveCondition: async (conditionId: string, fields: Record<string, FieldValue>) => {
        const saved = await db.updateNotebook((cur) => ({
          ...cur,
          conditions: cur.conditions.map((c) =>
            c.id === conditionId
              ? {
                  ...c,
                  rev: c.rev + 1,
                  updatedAt: Date.now(),
                  overrides: { ...c.overrides, ...fields },
                  overrideRevs: {
                    ...c.overrideRevs,
                    ...Object.fromEntries(Object.keys(fields).map((k) => [
                      k, c.overrideRevs[k] ?? c.rev + 1,
                    ])),
                  },
                }
              : c),
        }));
        return saved;
      },
      /** 直接落库当前本地笔记（测试辅助） */
      rawPutNotebook: (nb: Notebook) => db.putNotebook(nb),
      /** 等待防抖保存完成 */
      flush: (ms = 500) => new Promise((r) => setTimeout(r, ms)),
    };
  }, [loaded]);

  const onExport = () => {
    if (!notebook) return;
    if (formulas.length === 0) { setNotice("当前没有可导出的公式"); return; }
    downloadJSON(buildExport(formulas, notebook, Object.values(snapshots).flat()));
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const payload = parseImport(text, {
      formulaIds: new Set(formulas.map((f) => f.id)),
      conditionIds: new Set((notebook?.conditions ?? []).map((c) => c.id)),
      snapshotIds: new Set(Object.values(snapshots).flat().map((s) => s.id)),
    });
    if (payload.formulas.length === 0 && payload.errors.length) {
      setNotice(payload.errors[0] ?? "文件中没有可导入的公式");
      return;
    }
    setFormulas((fs) => [...fs, ...payload.formulas]);
    await db.bulkPutFormulas(payload.formulas).catch(() => undefined);
    if (payload.snapshots.length) {
      await db.bulkPutSnapshots(payload.snapshots).catch(() => undefined);
      setSnapshots((prev) => {
        const next = { ...prev };
        for (const s of payload.snapshots) {
          next[s.formulaId] = [s, ...(next[s.formulaId] ?? [])];
        }
        return next;
      });
    }
    // v1 旧文件：导入为一套独立、自包含、可追溯的工况（追加，不覆盖当前工况集）。
    // 迁移时一致变量原本进了导入笔记本的 defaults；合并到现有共享 defaults 会与当前笔记混淆，
    // 因此把这些值转成迁移工况自己的 overrides，使其在任何公共默认下都能原样复现旧结果。
    if (payload.legacy) {
      const base = notebookRef.current;
      const importedNb = payload.notebook;
      const migratedCond = importedNb.conditions[0];
      if (migratedCond) {
        migratedCond.overrides = { ...importedNb.defaults, ...migratedCond.overrides };
        migratedCond.overrideRevs = {
          ...Object.fromEntries(Object.keys(importedNb.defaults).map((k) => [k, migratedCond.rev])),
          ...migratedCond.overrideRevs,
        };
      }
      const merged: Notebook = base
        ? {
            ...base,
            defaults: base.defaults,
            conditions: [...base.conditions, ...importedNb.conditions],
            activeConditionId: migratedCond ? migratedCond.id : base.activeConditionId,
            updatedAt: Date.now(),
          }
        : { ...importedNb, activeConditionId: migratedCond ? migratedCond.id : importedNb.activeConditionId };
      if (base) {
        setNotebook(merged);
        persistNotebook(merged, base, { isDefaults: true });
      } else {
        await db.putNotebook(importedNb);
        baseRef.current = importedNb;
        setNotebook(importedNb);
      }
      setNotice(`已导入旧版笔记并生成可追溯的默认工况（${payload.formulas.length} 条公式）。${payload.notices.join("；")}`);
      return;
    }
    // v2：把导入文件的工况追加进来（id 已在 parseImport 中去重），切换到导入的选中工况。
    // 已有的公共默认不被导入文件覆盖（保护当前笔记）；仅补入缺失的变量。
    const base = notebookRef.current;
    if (base) {
      const defaults = { ...payload.notebook.defaults, ...base.defaults };
      const merged: Notebook = {
        ...base,
        conditions: [...base.conditions, ...payload.notebook.conditions],
        defaults,
        activeConditionId: payload.notebook.activeConditionId ?? base.activeConditionId,
        updatedAt: Date.now(),
      };
      setNotebook(merged);
      persistNotebook(merged, base, { isDefaults: true });
    }
    setNotice(`已导入 ${payload.formulas.length} 条公式与 ${payload.notebook.conditions.length} 套工况${
      payload.errors.length ? `；${payload.errors.length} 条问题（${payload.errors[0]}）` : ""
    }`);
  };

  if (!loaded || !notebook) {
    return <div className="app"><p className="muted">正在加载本地笔记…</p></div>;
  }

  const cond = activeCondition(notebook);
  const usable = conditionUsable(notebook);
  const allKnownNames = collectKnownNames(formulas, notebook);

  return (
    <div className="app">
      <header className="topbar">
        <h1>量纲检查笔记本</h1>
        <p className="subtitle">
          本地运行 · 数据仅保存在本浏览器（IndexedDB）· 参数工况集：常温 / 满载 / 故障一键切换，公共默认 + 工况覆盖
        </p>
        <div className="actions">
          <button type="button" onClick={add}>＋ 新建公式</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={() => addExample("unit")}>示例：单位运算</button>
          <button type="button" className="ghost" onClick={() => addExample("speed")}>示例：速度 s/t</button>
          <button type="button" className="ghost" onClick={() => addExample("degC")}>示例：摄氏温标</button>
          <button type="button" className="ghost" onClick={() => addExample("angle")}>示例：角度弧度</button>
          <button type="button" className="ghost" onClick={() => addExample("dimErr")}>示例：量纲错误</button>
          <button type="button" className="ghost" onClick={() => addExample("divZero")}>示例：除零</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={onExport}>导出 JSON（含工况）</button>
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {notice && <div className="notice">{notice}</div>}
      </header>

      <ConditionsBar
        notebook={notebook}
        onSwitch={switchCondition}
        onCreate={createCondition}
        onRename={renameActive}
        onDelete={deleteCondition}
        onRestore={restoreCond}
      />
      <DefaultsEditor
        defaults={notebook.defaults}
        knownNames={allKnownNames}
        warnings={defaultsWarnings}
        onChange={handleDefaultChange}
        onRemove={handleDefaultRemove}
      />

      <main>
        {formulas.length === 0 ? (
          <div className="empty-state">
            <p>还没有公式。点击「新建公式」或加载一个示例开始。</p>
            <p className="muted small">
              规则：先在「公共默认变量」或当前工况中给变量赋值（未赋值明确报错，不会自动取零）；
              切换工况即可在常温 / 满载 / 故障间比较同一套公式。
            </p>
          </div>
        ) : (
          formulas.map((f, i) => (
            <FormulaCard
              key={f.id}
              formula={f}
              index={i}
              condition={cond}
              conditionUsable={usable}
              defaultsRev={notebook.defaultsRev}
              fields={resolvedByFormula[f.id] ?? {}}
              snapshots={snapshots[f.id] ?? []}
              activeConditionId={notebook.activeConditionId}
              onChange={(patch) => updateFormula(f.id, patch)}
              onDelete={() => void removeFormula(f.id)}
              onOverride={handleOverride}
              onResetOverride={handleResetOverride}
              onMakeOverride={handleMakeOverride}
            />
          ))
        )}
      </main>

      {conflict && (
        <ConflictDialog
          conflict={conflict}
          onCancel={() => setConflict(null)}
          onResolve={(res, nameChoice) => resolveConflict(res, nameChoice)}
        />
      )}

      <footer className="footer">
        <p>
          每个变量字段分三级：工况覆盖值 &gt; 公共默认值 &gt;（旧版遗留值）；缺失即报未赋值，绝不取零。
          多标签页同工况编辑：不同改动字段自动合并，同一字段双方都改时逐字段裁决，任一方的单位或数值都不会被静默覆盖。
        </p>
      </footer>
    </div>
  );
}

// ---------- 辅助 ----------

function makeConditionDefaultFallback(): Condition {
  return { ...makeCondition("默认工况"), id: DEFAULT_CONDITION_ID };
}

function groupByFormula(all: CalcSnapshot[]): Record<string, CalcSnapshot[]> {
  const out: Record<string, CalcSnapshot[]> = {};
  for (const s of all) (out[s.formulaId] ??= []).push(s);
  for (const arr of Object.values(out)) arr.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** 需要在默认编辑器中提示的变量名（各公式出现的变量合集） */
function collectKnownNames(formulas: Formula[], nb: Notebook): string[] {
  const set = new Set<string>();
  for (const k of Object.keys(nb.defaults)) set.add(k);
  for (const f of formulas) {
    for (const k of Object.keys(f.legacyVariables ?? {})) set.add(k);
    for (const k of collectFormulaVarNames(f.latex)) set.add(k);
  }
  return [...set];
}

/** 单条公式在当前工况下的字段解析（覆盖 → 默认 → 遗留 → 缺失） */
function resolveForFormula(
  formula: Formula,
  nb: Notebook,
  cond: Condition | undefined,
): Record<string, FieldResolution> {
  const names = new Set<string>([
    ...collectFormulaVarNames(formula.latex),
    ...Object.keys(nb.defaults),
    ...Object.keys(cond?.overrides ?? {}),
    ...Object.keys(formula.legacyVariables ?? {}),
  ]);
  const out: Record<string, FieldResolution> = {};
  for (const name of names) {
    out[name] = resolveField(name, cond, nb.defaults, { legacy: formula.legacyVariables });
  }
  return out;
}
