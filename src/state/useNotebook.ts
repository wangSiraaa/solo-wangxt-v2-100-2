// 笔记本全局状态：加载 / 多标签页同步 / 工况与公共默认的 CAS 保存 / 冲突处理
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CalcSnapshot, ConflictEvent, FieldKey, Formula,
  PublicDefaultsDoc, Scenario, ScenarioVar, TrashItem,
} from "../engine/types";
import {
  commitDefaults, commitScenario, findFieldConflicts, makeScenario, mergeFields,
  resolveConflictField, sanitizeScenarioVars,
} from "../engine/scenarios";
import {
  addConflict, deleteFormula as idbDeleteFormula, importBundle, loadState,
  putFormula, purgeTrash as idbPurgeTrash, renameScenario as idbRenameScenario,
  restoreScenario as idbRestoreScenario,
  saveDefaults, saveScenario, setActiveScenario as idbSetActive, trashScenario as idbTrash,
  insertScenario, updateConflict, putSnapshot, deleteSnapshot, type NotebookState,
} from "../storage/db";
import { parseImport } from "../storage/exchange";
import { newId, TAB_ID } from "../storage/id";

const SAVE_DEBOUNCE = 350;
const CHANNEL = "dimension-notebook-v2";

interface Draft {
  kind: "scenario" | "defaults";
  id: string;
  baseRev: number;
  baseVars: Record<string, ScenarioVar>;
  vars: Record<string, ScenarioVar>;
  timer: number | undefined;
}

// 跨 StrictMode 双重挂载共享的可变账本：React 18 开发模式会
// mount→unmount→remount 同一个组件，useRef 在两次挂载间不共享，
// 若把未落盘草稿放在 ref 里，第二次挂载的初始 loadState() 一回来就会把它冲掉。
// 模块级单例保证同一标签页实例内只有一份“未保存草稿 / 待写公式”。
const drafts = new Map<string, Draft>();
const pendingFormulas = new Map<string, Formula>();
let formulaTimer: number | undefined;
let suspendReapply = false;
let bcRef: BroadcastChannel | undefined;

export interface NotebookApi extends NotebookState {
  activeScenario?: Scenario;
  notice: string;
  setNotice: (s: string) => void;
  // 工况
  selectScenario: (id: string) => void;
  addScenario: (name: string) => Promise<Scenario>;
  renameScenario: (id: string, name: string) => void;
  removeScenario: (id: string) => Promise<void>;
  restoreTrash: (trashId: string) => Promise<void>;
  purgeTrash: (trashId: string) => Promise<void>;
  setOverride: (scenarioId: string, name: string, field: FieldKey, text: string) => void;
  // 公共默认
  setDefaultVar: (name: string, value: string, unit: string) => void;
  removeDefaultVar: (name: string) => void;
  // 公式
  updateFormula: (id: string, patch: Partial<Formula>) => void;
  addFormula: (f: Formula) => void;
  removeFormula: (id: string) => void;
  // 快照
  saveSnapshot: (s: CalcSnapshot) => Promise<void>;
  removeSnapshot: (id: string) => void;
  // 冲突
  resolveConflictChoice: (conflictId: string, picks: Record<string, "local" | "remote">) => Promise<void>;
  discardConflictDraft: (conflictId: string) => Promise<void>;
  // 导入
  importText: (text: string) => Promise<{ imported: number; errors: string[]; migrated: boolean }>;
}

export function useNotebook(): { api: NotebookApi | null; loaded: boolean } {
  const [state, setState] = useState<NotebookState | null>(null);
  const [notice, setNotice] = useState("");
  const stateRef = useRef<NotebookState | null>(null);
  stateRef.current = state;

  const refresh = useCallback(async (silent = false) => {
    try {
      const next = await loadState();
      setState((prev) => {
        if (!prev) return next;
        // 外部变更后，把本标签页未落盘草稿 rebase 到对端最新修订：
        // 三方合并（本标签页的 base/草稿 vs 对端最新），只把无冲突字段套回 UI，
        // 同字段冲突留给保存时的 CAS 统一报出（避免闪烁与误覆盖）。
        if (!suspendReapply) {
          for (const draft of drafts.values()) {
            if (draft.kind === "scenario") {
              const s = next.scenarios.find((x) => x.id === draft.id);
              if (s) {
                const idx = next.scenarios.indexOf(s);
                const { merged, conflicts } = mergeFields(draft.baseVars, draft.vars, s.variables);
                if (conflicts.length === 0) {
                  // 无同字段冲突：本地草稿 rebase 到对端最新修订
                  draft.baseRev = s.rev;
                  draft.baseVars = structuredClone(s.variables);
                  draft.vars = merged;
                  next.scenarios[idx] = { ...s, variables: structuredClone(merged) };
                } else {
                  // 有同字段冲突：界面先显示本地未保存值，不 rebase；
                  // 下一次 CAS 保存会被拒绝并弹出字段级冲突面板（双方都不丢）
                  next.scenarios[idx] = { ...s, variables: structuredClone(draft.vars) };
                }
              }
            } else if (draft.kind === "defaults") {
              const remoteSparse = toSparse(next.defaults.variables);
              const { merged, conflicts } = mergeFields(draft.baseVars, draft.vars, remoteSparse);
              if (conflicts.length === 0) {
                draft.baseRev = next.defaults.rev;
                draft.baseVars = structuredClone(remoteSparse);
                draft.vars = merged;
                next.defaults = { ...next.defaults, variables: toVarDefs(merged) };
              } else {
                next.defaults = { ...next.defaults, variables: toVarDefs(draft.vars) };
              }
            }
          }
        }
        return next;
      });
      void silent;
    } catch (e) {
      if (!silent) setNotice(`读取本地存储失败：${(e as Error).message}`);
    }
  }, []);

  // 初始加载
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 多标签页同步：BroadcastChannel + 窗口重新聚焦
  useEffect(() => {
    let bc: BroadcastChannel | undefined;
    try {
      bc = new BroadcastChannel(CHANNEL);
      bcRef = bc;
      let timer: number | undefined;
      bc.onmessage = (ev) => {
        if (ev.data?.tabId === TAB_ID) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void refresh(true), 200);
      };
    } catch { /* BroadcastChannel 不可用时退化为聚焦刷新 */ }
    const onFocus = () => void refresh(true);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      bc?.close();
      bcRef = undefined;
    };
  }, [refresh]);

  const announce = useCallback(() => {
    try { bcRef?.postMessage({ tabId: TAB_ID, at: Date.now() }); } catch { /* ignore */ }
  }, []);

  const flushFormulas = useCallback(() => {
    const batch = [...pendingFormulas.values()];
    pendingFormulas.clear();
    if (!batch.length) return;
    Promise.all(batch.map((f) => putFormula(f))).catch((e) =>
      setNotice(`公式保存失败：${(e as Error).message}`));
  }, []);

  // React 18 StrictMode 会 mount→unmount→remount：useRef 在两次挂载间保留，
  // 因此**不能**在卸载时清除防抖保存定时器，否则已安排的落盘会被误杀。
  // 真实页面卸载时浏览器会自动回收这些定时器。

  // ---------- 工况 CAS 保存 ----------

  const flushScenarioDraft = useCallback(async (scenarioId: string) => {
    const draft = drafts.get(scenarioId);
    if (!draft || draft.kind !== "scenario") return;
    const vars = structuredClone(draft.vars);
    const res = await saveScenario(scenarioId, draft.baseRev, (remote) =>
      commitScenario(remote, vars, remote.rev + 1, TAB_ID, `标签页 ${TAB_ID.slice(-4)} 编辑`));

    if (res.ok) {
      drafts.delete(scenarioId);
      suspendReapply = true;
      await refresh(true);
      suspendReapply = false;
      announce();
      return;
    }

    if (res.code === "missing") {
      // 工况已被对端删除：拒绝写入，保留草稿为冲突事件，绝不复活/污染其他工况
      const evt = buildConflict("scenario", scenarioId, "（已删除工况）", draft, {}, true, 0);
      await addConflict(evt);
      drafts.delete(scenarioId);
      await refresh(true);
      setNotice(`工况已被另一标签页删除：你修改的数值/单位已保留在“冲突与回收站”中，可恢复工况后再合并`);
      announce();
      return;
    }

    if (res.code === "rev-conflict") {
      const remoteVars = sanitizeScenarioVars(res.remoteVars);
      const { merged, conflicts } = mergeFields(draft.baseVars, vars, remoteVars);
      if (conflicts.length === 0) {
        // 字段级自动合并：不同字段无冲突，直接以对端修订为基底再提一版
        const res2 = await saveScenario(scenarioId, res.remoteRev, (remote) =>
          commitScenario(remote, merged, remote.rev + 1, TAB_ID,
            `与标签页修订 ${res.remoteRev} 字段级自动合并`));
        if (res2.ok) {
          drafts.delete(scenarioId);
          suspendReapply = true;
          await refresh(true);
          suspendReapply = false;
          setNotice(`已与另一标签页的修改自动合并（不同字段，无冲突），现为修订 ${res2.rev}`);
          announce();
          return;
        }
      }
      // 同字段冲突：明确拒绝，登记冲突，界面回退到已保存版本，本地草稿原样保留
      const remoteName = stateRef.current?.scenarios.find((s) => s.id === scenarioId)?.name ?? "工况";
      const evt = buildConflict("scenario", scenarioId, remoteName, draft, remoteVars, false, res.remoteRev);
      await addConflict(evt);
      drafts.delete(scenarioId);
      suspendReapply = true;
      await refresh(true);
      suspendReapply = false;
      setNotice(`检测到修订冲突：另一标签页已保存同一字段，本次写入已拒绝（双方历史均保留），请在“冲突与回收站”逐字段选择`);
      announce();
      return;
    }

    setNotice(res.message);
  }, [announce, refresh, setNotice]);

  const scheduleScenarioSave = useCallback((scenarioId: string) => {
    const draft = drafts.get(scenarioId);
    if (!draft) return;
    window.clearTimeout(draft.timer);
    draft.timer = window.setTimeout(() => { void flushScenarioDraft(scenarioId); }, SAVE_DEBOUNCE);
  }, [flushScenarioDraft]);

  const setOverride = useCallback((scenarioId: string, name: string, field: FieldKey, text: string) => {
    const prev = stateRef.current;
    if (!prev) return;
    const scn = prev.scenarios.find((s) => s.id === scenarioId);
    // 工况可能刚在同一事件循环中创建（setState 尚未反映到 ref）：
    // 此时若草稿已存在（addScenario 之后），就以草稿为准继续写入。
    const existingDraft = drafts.get(scenarioId);
    if (!scn && !existingDraft) return;
    // 在 setState 之外同步建立/更新草稿：setState 更新函数会被 React 延迟
    // （StrictMode 下还会重复调用），保存调度必须能立刻看到草稿。
    let draft = existingDraft;
    if (!draft && scn) {
      draft = {
        kind: "scenario", id: scenarioId, baseRev: scn.rev,
        baseVars: structuredClone(scn.variables), vars: structuredClone(scn.variables),
        timer: undefined,
      };
      drafts.set(scenarioId, draft);
    }
    if (!draft) return;
    draft.vars = applyField(draft.vars, name, field, text);
    const nextVars = structuredClone(draft.vars);

    setState((p) => p ? {
      ...p,
      scenarios: p.scenarios.map((s) => (s.id === scenarioId ? { ...s, variables: nextVars } : s)),
    } : p);
    scheduleScenarioSave(scenarioId);
  }, [scheduleScenarioSave]);

  // ---------- 公共默认 CAS ----------

  const flushDefaultsDraft = useCallback(async () => {
    const draft = drafts.get("defaults");
    if (!draft || draft.kind !== "defaults") return;
    const vars = toVarDefs(draft.vars);
    const res = await saveDefaults(draft.baseRev, (remote) =>
      commitDefaults(remote, vars, remote.rev + 1, TAB_ID, `标签页 ${TAB_ID.slice(-4)} 编辑公共默认`));

    if (res.ok) {
      drafts.delete("defaults");
      suspendReapply = true;
      await refresh(true);
      suspendReapply = false;
      announce();
      return;
    }
    if (res.code === "rev-conflict" || res.code === "missing") {
      const remoteVars = sanitizeScenarioVars(res.remoteVars);
      const { merged, conflicts } = mergeFields(draft.baseVars, draft.vars, remoteVars);
      if (conflicts.length === 0) {
        const res2 = await saveDefaults(res.remoteRev, (remote) =>
          commitDefaults(remote, toVarDefs(merged), remote.rev + 1, TAB_ID,
            `与标签页修订 ${res.remoteRev} 字段级自动合并`));
        if (res2.ok) {
          drafts.delete("defaults");
          suspendReapply = true;
          await refresh(true);
          suspendReapply = false;
          setNotice(`公共默认变量已与另一标签页的修改自动合并，现为修订 ${res2.rev}`);
          announce();
          return;
        }
      }
      const evt = buildConflict("defaults", "defaults", "公共默认变量", draft, remoteVars, res.code === "missing", res.remoteRev);
      await addConflict(evt);
      drafts.delete("defaults");
      suspendReapply = true;
      await refresh(true);
      suspendReapply = false;
      setNotice(`公共默认变量存在跨标签页同字段冲突，写入已拒绝，请在“冲突与回收站”处理`);
      announce();
      return;
    }
    setNotice(res.message);
  }, [announce, refresh, setNotice]);

  const scheduleDefaultsSave = useCallback(() => {
    const draft = drafts.get("defaults");
    if (!draft) return;
    window.clearTimeout(draft.timer);
    draft.timer = window.setTimeout(() => { void flushDefaultsDraft(); }, SAVE_DEBOUNCE);
  }, [flushDefaultsDraft]);

  const mutateDefault = useCallback((name: string, next: { value: string; unit: string } | null) => {
    const prev = stateRef.current;
    if (!prev) return;
    let draft = drafts.get("defaults");
    if (!draft) {
      draft = {
        kind: "defaults", id: "defaults", baseRev: prev.defaults.rev,
        baseVars: toSparse(prev.defaults.variables), vars: toSparse(prev.defaults.variables),
        timer: undefined,
      };
      drafts.set("defaults", draft);
    }
    const vars = structuredClone(draft.vars);
    if (next === null || (next.value.trim() === "" && next.unit.trim() === "")) {
      delete vars[name];
    } else {
      const entry: ScenarioVar = {};
      if (next.value.trim() !== "") entry.value = next.value;
      if (next.unit.trim() !== "") entry.unit = next.unit;
      vars[name] = entry;
    }
    draft.vars = vars;
    const nextDefs = toVarDefs(vars);
    setState((p) => p ? { ...p, defaults: { ...p.defaults, variables: nextDefs } } : p);
    scheduleDefaultsSave();
  }, [scheduleDefaultsSave]);

  // ---------- 工况管理 ----------

  const selectScenario = useCallback((id: string) => {
    setState((prev) => prev ? { ...prev, meta: { ...prev.meta, activeScenarioId: id } } : prev);
    void idbSetActive(id).catch((e) => setNotice(`切换工况失败：${(e as Error).message}`));
  }, []);

  const addScenario = useCallback(async (name: string): Promise<Scenario> => {
    const s = makeScenario(name || `工况 ${(stateRef.current?.scenarios.length ?? 0) + 1}`);
    await insertScenario(s);
    await idbSetActive(s.id);
    // 同步更新 ref：调用方常在 await addScenario(...) 之后立刻写覆盖，
    // 若等 React 提交后 ref 才更新，第一批 setOverride 会找不到工况。
    stateRef.current = stateRef.current ? {
      ...stateRef.current,
      scenarios: [...stateRef.current.scenarios, s],
      meta: { ...stateRef.current.meta, activeScenarioId: s.id },
    } : stateRef.current;
    setState((prev) => prev ? {
      ...prev,
      scenarios: [...prev.scenarios, s],
      meta: { ...prev.meta, activeScenarioId: s.id },
    } : prev);
    announce();
    return s;
  }, [announce]);

  const renameScenario = useCallback((id: string, name: string) => {
    const scn = stateRef.current?.scenarios.find((s) => s.id === id);
    if (!scn) return;
    setState((prev) => prev ? {
      ...prev, scenarios: prev.scenarios.map((s) => (s.id === id ? { ...s, name } : s)),
    } : prev);
    void idbRenameScenario(id, scn.rev, name, TAB_ID).then(async (r) => {
      if (!r.ok) { await refresh(true); setNotice(r.message); return; }
      announce();
    });
  }, [announce, refresh]);

  const removeScenario = useCallback(async (id: string) => {
    let deleted: Scenario;
    try {
      deleted = await idbTrash(id);
    } catch (e) {
      setNotice(`删除工况失败：${(e as Error).message}`);
      return;
    }
    const trashItem: TrashItem = {
      id: `trash_${deleted.id}`, kind: "scenario", docId: deleted.id,
      name: deleted.name, deletedAt: Date.now(), doc: deleted,
    };
    setState((prev) => {
      if (!prev) return prev;
      const scenarios = prev.scenarios.filter((s) => s.id !== id);
      const active = prev.meta.activeScenarioId === id
        ? (scenarios[0]?.id ?? "")
        : prev.meta.activeScenarioId;
      void idbSetActive(active).catch(() => undefined);
      // 快照标记工况缺失
      const snapshots = prev.snapshots.map((s) =>
        s.scenarioId === id ? { ...s, scenarioMissing: true } : s);
      return {
        ...prev, scenarios, snapshots,
        trash: [trashItem, ...prev.trash.filter((t) => t.id !== trashItem.id)],
        meta: { ...prev.meta, activeScenarioId: active },
      };
    });
    drafts.delete(id);
    announce();
  }, [announce]);

  const restoreTrash = useCallback(async (trashId: string) => {
    const r = await idbRestoreScenario(trashId);
    if (!r.ok) { setNotice(r.message); return; }
    await refresh(true);
    setState((prev) => {
      if (!prev) return prev;
      const restored = prev.trash.find((t) => t.id === trashId);
      const active = restored?.docId ?? prev.meta.activeScenarioId;
      void idbSetActive(active).catch(() => undefined);
      const snapshots = prev.snapshots.map((s) =>
        restored && s.scenarioId === restored.docId ? { ...s, scenarioMissing: false } : s);
      return {
        ...prev,
        trash: prev.trash.filter((t) => t.id !== trashId),
        snapshots,
        meta: { ...prev.meta, activeScenarioId: active },
      };
    });
    announce();
  }, [announce, refresh]);

  const purgeTrash = useCallback(async (trashId: string) => {
    await idbPurgeTrash(trashId).catch((e) => setNotice(`彻底删除失败：${(e as Error).message}`));
    setState((prev) => prev ? { ...prev, trash: prev.trash.filter((t) => t.id !== trashId) } : prev);
    announce();
  }, [announce]);

  // ---------- 公式 ----------

  const updateFormula = useCallback((id: string, patch: Partial<Formula>) => {
    setState((prev) => {
      if (!prev) return prev;
      const formulas = prev.formulas.map((f) => {
        if (f.id !== id) return f;
        const next = { ...f, ...patch, updatedAt: Date.now() };
        pendingFormulas.set(id, next);
        return next;
      });
      window.clearTimeout(formulaTimer);
      formulaTimer = window.setTimeout(() => flushFormulas(), SAVE_DEBOUNCE);
      return { ...prev, formulas };
    });
  }, [flushFormulas]);

  const addFormula = useCallback((f: Formula) => {
    setState((prev) => {
      if (!prev) return prev;
      pendingFormulas.set(f.id, f);
      window.clearTimeout(formulaTimer);
      formulaTimer = window.setTimeout(() => flushFormulas(), SAVE_DEBOUNCE);
      return { ...prev, formulas: [...prev.formulas, f] };
    });
  }, [flushFormulas]);

  const removeFormula = useCallback(async (id: string) => {
    setState((prev) => {
      if (!prev) return prev;
      const snapshots = prev.snapshots.map((s) =>
        s.formulaId === id ? { ...s, formulaDeleted: true } : s);
      return { ...prev, formulas: prev.formulas.filter((f) => f.id !== id), snapshots };
    });
    await idbDeleteFormula(id).catch(() => undefined);
    announce();
  }, [announce]);

  // ---------- 快照 ----------

  const saveSnapshot = useCallback(async (s: CalcSnapshot) => {
    await putSnapshot(s);
    setState((prev) => prev ? { ...prev, snapshots: [s, ...prev.snapshots] } : prev);
    announce();
  }, [announce]);

  const removeSnapshot = useCallback(async (id: string) => {
    await deleteSnapshot(id);
    setState((prev) => prev ? { ...prev, snapshots: prev.snapshots.filter((s) => s.id !== id) } : prev);
    announce();
  }, [announce]);

  // ---------- 冲突解决 ----------

  const persistMerged = useCallback(async (evt: ConflictEvent, merged: Record<string, ScenarioVar>, note: string) => {
    if (evt.kind === "scenario") {
      const r = await saveScenario(evt.docId, evt.remoteRev, (remote) =>
        commitScenario(remote, merged, remote.rev + 1, TAB_ID, note));
      if (!r.ok) throw new Error(r.message);
    } else {
      const r = await saveDefaults(evt.remoteRev, (remote) =>
        commitDefaults(remote, toVarDefs(merged), remote.rev + 1, TAB_ID, note));
      if (!r.ok) throw new Error(r.message);
    }
  }, []);

  const resolveConflictChoice = useCallback(async (conflictId: string, picks: Record<string, "local" | "remote">) => {
    const evt = stateRef.current?.conflicts.find((c) => c.id === conflictId);
    if (!evt) return;
    let { merged } = mergeFields(evt.baseVars, evt.draft, evt.remoteVars);
    for (const c of evt.conflicts) {
      const pick = picks[`${c.varName} ${c.field}`];
      if (pick) merged = resolveConflictField(merged, c, pick);
    }
    const unresolved = evt.conflicts.filter((c) => !picks[`${c.varName} ${c.field}`]);
    if (unresolved.length) {
      setNotice(`还有 ${unresolved.length} 个冲突字段未选择，未保存`);
      return;
    }
    try {
      await persistMerged(evt, merged, `冲突手动解决（${evt.conflicts.length} 个字段逐字段选择）`);
      await updateConflict(conflictId, { resolved: true, resolvedAt: Date.now(), resolution: "merged" });
      // 若冲突源于已删工况，上面会 missing——单独处理
    } catch (e) {
      setNotice(`合并保存失败：${(e as Error).message}（双方数据仍保留，可再次尝试）`);
      return;
    }
    suspendReapply = true;
    await refresh(true);
    suspendReapply = false;
    announce();
    setNotice("冲突已按你的字段级选择合并保存，双方历史均保留");
  }, [announce, persistMerged, refresh]);

  const discardConflictDraft = useCallback(async (conflictId: string) => {
    await updateConflict(conflictId, { resolved: true, resolvedAt: Date.now(), resolution: "discarded-local" });
    await refresh(true);
    announce();
  }, [announce, refresh]);

  // ---------- 导入 ----------

  const importText = useCallback(async (text: string) => {
    const prev = stateRef.current;
    if (!prev) return { imported: 0, errors: ["数据尚未加载完成"], migrated: false };
    const existing = new Set<string>([
      ...prev.formulas.map((f) => f.id),
      ...prev.scenarios.map((s) => s.id),
      ...prev.snapshots.map((s) => s.id),
    ]);
    const { bundle, errors } = parseImport(text, existing);
    if (!bundle) return { imported: 0, errors, migrated: false };

    // 公共默认与现有并集合并（不覆盖教师已有的同名变量）
    const mergedDefaults: PublicDefaultsDoc = {
      ...prev.defaults,
      variables: { ...bundle.defaults.variables, ...prev.defaults.variables },
    };
    if (bundle.migrated) {
      mergedDefaults.origin = prev.defaults.variables && Object.keys(prev.defaults.variables).length
        ? `${prev.defaults.origin ?? "公共默认变量"}；并入旧版导入变量 · ${new Date(bundle.migratedAt).toLocaleString()}`
        : bundle.defaults.origin;
      mergedDefaults.rev = prev.defaults.rev + 1;
    }

    await importBundle({
      formulas: bundle.formulas,
      scenarios: bundle.scenarios,
      defaults: mergedDefaults,
      snapshots: bundle.snapshots,
    });
    const activate = bundle.migrated ? bundle.scenarios[0]?.id : undefined;
    if (activate) await idbSetActive(activate);
    await refresh(true);
    announce();
    return {
      imported: bundle.formulas.length,
      errors,
      migrated: bundle.migrated,
    };
  }, [announce, refresh]);

  const activeScenario = useMemo(
    () => state?.scenarios.find((s) => s.id === state.meta.activeScenarioId),
    [state],
  );

  if (!state) return { api: null, loaded: false };

  const api: NotebookApi = {
    ...state,
    activeScenario,
    notice,
    setNotice,
    selectScenario,
    addScenario,
    renameScenario,
    removeScenario,
    restoreTrash,
    purgeTrash,
    setOverride,
    setDefaultVar: (name, value, unit) => mutateDefault(name, { value, unit }),
    removeDefaultVar: (name) => mutateDefault(name, null),
    updateFormula,
    addFormula,
    removeFormula,
    saveSnapshot,
    removeSnapshot,
    resolveConflictChoice,
    discardConflictDraft,
    importText,
  };
  return { api, loaded: true };
}

// ---------- 工具 ----------

function applyField(
  vars: Record<string, ScenarioVar>,
  name: string,
  field: FieldKey,
  text: string,
): Record<string, ScenarioVar> {
  const next = structuredClone(vars);
  const cur: ScenarioVar = next[name] ? { ...next[name] } : {};
  if (text.trim() === "") delete cur[field];
  else cur[field] = text;
  if (Object.keys(cur).length === 0) delete next[name];
  else next[name] = cur;
  return next;
}

function toSparse(defs: Record<string, { value: string; unit: string }>): Record<string, ScenarioVar> {
  const out: Record<string, ScenarioVar> = {};
  for (const [k, v] of Object.entries(defs)) {
    const e: ScenarioVar = {};
    if (v.value.trim() !== "") e.value = v.value;
    if (v.unit.trim() !== "") e.unit = v.unit;
    if (Object.keys(e).length) out[k] = e;
  }
  return out;
}

function toVarDefs(sparse: Record<string, ScenarioVar>): Record<string, { value: string; unit: string }> {
  const out: Record<string, { value: string; unit: string }> = {};
  for (const [k, v] of Object.entries(sparse)) {
    out[k] = { value: v.value ?? "", unit: v.unit ?? "" };
  }
  return out;
}

function buildConflict(
  kind: ConflictEvent["kind"],
  docId: string,
  docName: string,
  draft: Draft,
  remoteVars: Record<string, ScenarioVar>,
  remoteDeleted: boolean,
  remoteRev: number,
): ConflictEvent {
  return {
    id: newId("cf"),
    kind,
    docId,
    docName,
    detectedAt: Date.now(),
    tabId: TAB_ID,
    baseRev: draft.baseRev,
    remoteRev,
    baseVars: structuredClone(draft.baseVars),
    draft: structuredClone(draft.vars),
    remoteVars: structuredClone(remoteVars),
    conflicts: findFieldConflicts(draft.baseVars, draft.vars, remoteVars),
    remoteDeleted,
    resolved: false,
  };
}
