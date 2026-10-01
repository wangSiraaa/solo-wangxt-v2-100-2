// IndexedDB 本地持久化（v2：公式 / 工况笔记 / 计算快照 三个独立 store）。
// 无服务器，所有数据仅保存在浏览器本地。
import type { CalcSnapshot, Formula, Notebook } from "../engine/types";

const DB_NAME = "dimension-notebook";
const STORE_FORMULAS = "formulas";
const STORE_NOTEBOOK = "notebook";
const STORE_SNAPSHOTS = "snapshots";
const NOTEBOOK_KEY = "main";
export const DB_VERSION = 2;

/** v1 行：变量直接挂在公式上（迁移时读取） */
export interface LegacyFormulaRow {
  id: string;
  latex: string;
  note: string;
  variables?: unknown;
  targetUnit: string;
  createdAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 已存在 formulas store；v2 新增工况笔记与计算快照
      if (!db.objectStoreNames.contains(STORE_FORMULAS)) {
        db.createObjectStore(STORE_FORMULAS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_NOTEBOOK)) {
        db.createObjectStore(STORE_NOTEBOOK, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const snap = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: "id" });
        snap.createIndex("formulaId", "formulaId", { unique: false });
        snap.createIndex("conditionId", "conditionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  stores: string[],
  run: (stores: Record<string, IDBObjectStore>) => IDBRequest<T> | undefined,
): Promise<T> {
  return openDB().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const t = database.transaction(stores, mode);
        const map: Record<string, IDBObjectStore> = {};
        for (const s of stores) map[s] = t.objectStore(s);
        const req = run(map);
        if (!req) { reject(new Error("no request")); database.close(); return; }
        req.onsuccess = () => { resolve(req.result); database.close(); };
        req.onerror = () => { reject(req.error); database.close(); };
      }),
  );
}

// ---------- 跨标签页变更通知 ----------

export type ChangeKind = "notebook" | "formula" | "snapshot";
type ChangeListener = (kind: ChangeKind) => void;

let channel: BroadcastChannel | null = null;
const listeners = new Set<ChangeListener>();
const BEACON_KEY = "dimension-notebook-beacon";

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("dimension-notebook-v2");
  channel.onmessage = (e: MessageEvent) => {
    if (e?.data && typeof e.data.kind === "string") {
      listeners.forEach((fn) => fn(e.data.kind as ChangeKind));
    }
  };
}

export function subscribeChanges(fn: ChangeListener): () => void {
  ensureChannel();
  listeners.add(fn);
  // BroadcastChannel 不可用时的退路：localStorage storage 事件
  const onStorage = (e: StorageEvent) => {
    if (e.key === BEACON_KEY && e.newValue) {
      try { fn(JSON.parse(e.newValue).kind as ChangeKind); } catch { /* ignore */ }
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

function notify(kind: ChangeKind): void {
  if (channel) channel.postMessage({ kind, at: Date.now() });
  if (typeof localStorage !== "undefined") {
    try { localStorage.setItem(BEACON_KEY, JSON.stringify({ kind, at: Date.now() })); } catch { /* ignore */ }
  }
}

// ---------- 修订冲突 ----------

export class RevisionConflict extends Error {
  fresh: Notebook;
  constructor(fresh: Notebook) {
    super("工况已被其他标签页修改（修订号不一致）");
    this.name = "RevisionConflict";
    this.fresh = fresh;
  }
}

export interface RevisionExpectation {
  /** 本次保存涉及的工况 id → 预期修订号 */
  conditionRevs?: Record<string, number>;
  /** 预期公共默认层修订号 */
  defaultsRev?: number;
}

export const db = {
  // ----- 公式 -----
  async allFormulas(): Promise<(Formula | LegacyFormulaRow)[]> {
    const rows = await tx<(Formula | LegacyFormulaRow)[]>("readonly", [STORE_FORMULAS],
      (s) => s[STORE_FORMULAS].getAll() as IDBRequest<(Formula | LegacyFormulaRow)[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  async putFormula(formula: Formula, quiet = false): Promise<void> {
    await tx<IDBValidKey>("readwrite", [STORE_FORMULAS], (s) => s[STORE_FORMULAS].put(formula));
    if (!quiet) notify("formula");
  },
  async bulkPutFormulas(formulas: Formula[], quiet = false): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(STORE_FORMULAS, "readwrite");
      const store = t.objectStore(STORE_FORMULAS);
      for (const f of formulas) store.put(f);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
    if (!quiet) notify("formula");
  },
  async deleteFormula(id: string): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction([STORE_FORMULAS, STORE_SNAPSHOTS], "readwrite");
      t.objectStore(STORE_FORMULAS).delete(id);
      // 同时清理该公式的快照
      const idx = t.objectStore(STORE_SNAPSHOTS).index("formulaId");
      idx.openCursor(id).onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
    notify("snapshot");
    notify("formula");
  },

  // ----- 工况笔记（修订号乐观并发） -----
  async getNotebook(): Promise<Notebook | null> {
    return tx<Notebook | null>("readonly", [STORE_NOTEBOOK],
      (s) => s[STORE_NOTEBOOK].get(NOTEBOOK_KEY) as IDBRequest<Notebook | null>);
  },
  /**
   * 事务内读改写并做修订号校验：
   * expected 中任一工况修订号 / 默认层修订号与库中不一致 → RevisionConflict（绝不写入）。
   */
  async updateNotebook(
    apply: (nb: Notebook) => Notebook,
    expected?: RevisionExpectation,
  ): Promise<Notebook> {
    const database = await openDB();
    return new Promise<Notebook>((resolve, reject) => {
      const t = database.transaction(STORE_NOTEBOOK, "readwrite");
      const store = t.objectStore(STORE_NOTEBOOK);
      const getReq = store.get(NOTEBOOK_KEY);
      getReq.onsuccess = () => {
        const current = getReq.result as Notebook | undefined;
        if (!current) { reject(new Error("工况笔记尚未初始化")); return; }
        if (expected) {
          if (expected.defaultsRev !== undefined && current.defaultsRev !== expected.defaultsRev) {
            reject(new RevisionConflict(current));
            return;
          }
          for (const [id, rev] of Object.entries(expected.conditionRevs ?? {})) {
            const c = current.conditions.find((x) => x.id === id);
            if (!c || c.rev !== rev) { reject(new RevisionConflict(current)); return; }
          }
        }
        const next = apply(current);
        store.put({ ...next, updatedAt: Date.now() });
        t.oncomplete = () => { resolve(next); database.close(); notify("notebook"); };
      };
      getReq.onerror = () => { reject(getReq.error); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
  },
  async putNotebook(nb: Notebook): Promise<void> {
    await tx<IDBValidKey>("readwrite", [STORE_NOTEBOOK],
      (s) => s[STORE_NOTEBOOK].put(nb));
    notify("notebook");
  },

  // ----- 计算快照 -----
  async putSnapshot(snapshot: CalcSnapshot): Promise<void> {
    await tx<IDBValidKey>("readwrite", [STORE_SNAPSHOTS],
      (s) => s[STORE_SNAPSHOTS].put(snapshot));
    notify("snapshot");
  },
  async bulkPutSnapshots(snapshots: CalcSnapshot[]): Promise<void> {
    if (!snapshots.length) return;
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(STORE_SNAPSHOTS, "readwrite");
      const store = t.objectStore(STORE_SNAPSHOTS);
      for (const s of snapshots) store.put(s);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
    notify("snapshot");
  },
  async snapshotsForFormula(formulaId: string): Promise<CalcSnapshot[]> {
    const rows = await tx<CalcSnapshot[]>("readonly", [STORE_SNAPSHOTS],
      (s) => (s[STORE_SNAPSHOTS].index("formulaId").getAll(formulaId) as IDBRequest<CalcSnapshot[]>));
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
  async allSnapshots(): Promise<CalcSnapshot[]> {
    return tx<CalcSnapshot[]>("readonly", [STORE_SNAPSHOTS],
      (s) => s[STORE_SNAPSHOTS].getAll() as IDBRequest<CalcSnapshot[]>);
  },
  /** 每个 公式×工况 只保留最新 keep 条（旧记录不抹除工况/版本信息） */
  async pruneSnapshots(keep = 20): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(STORE_SNAPSHOTS, "readwrite");
      const store = t.objectStore(STORE_SNAPSHOTS);
      const allReq = store.getAll() as IDBRequest<CalcSnapshot[]>;
      allReq.onsuccess = () => {
        const groups = new Map<string, CalcSnapshot[]>();
        for (const s of allReq.result) {
          const key = `${s.formulaId}|${s.conditionId}`;
          const arr = groups.get(key) ?? [];
          arr.push(s);
          groups.set(key, arr);
        }
        for (const arr of groups.values()) {
          arr.sort((a, b) => b.createdAt - a.createdAt);
          arr.slice(keep).forEach((s) => store.delete(s.id));
        }
      };
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
  },
};

export function newId(prefix = "f"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const newSnapshotId = (): string => newId("snap");
