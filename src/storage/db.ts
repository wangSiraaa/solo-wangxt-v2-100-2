// IndexedDB 本地持久化（v2：参数工况集 + 公共默认变量 + 计算快照 + 冲突 + 回收站）。
// 无服务器，所有数据仅保存在浏览器本地。
//
// 多标签页：所有写入都在单个 readwrite 事务内做“读-校验-写”，
// IndexedDB 的事务可见性保证同一时刻只有一个事务能改同一 store，
// 因而 CAS（修订号乐观锁）在多标签页下严格成立——绝不静默覆盖对端保存。
import type {
  CalcSnapshot, ConflictEvent, Formula, MetaDoc, PublicDefaultsDoc,
  Scenario, TrashItem, VariableDef,
} from "../engine/types";
import {
  DEFAULT_SCENARIO_ID, makeDefaultScenario, makeDefaults, sanitizeVarDefs,
} from "../engine/scenarios";
import { newId } from "./id";

const DB_NAME = "dimension-notebook";
const VERSION = 2;

const S = {
  formulas: "formulas",       // v1 既有（keyPath id），升级时原地迁移后重建为 v2 公式
  scenarios: "scenarios",     // 工况（含 rev 与历史）
  defaults: "defaults",       // 公共默认变量（单例 id="defaults"）
  snapshots: "snapshots",     // 冻结计算记录
  conflicts: "conflicts",     // 多标签页写入冲突（拒绝时留存）
  trash: "trash",             // 工况软删除回收站
  meta: "meta",               // 单例 id="meta"：当前选中工况
} as const;

export type NotebookState = {
  formulas: Formula[];
  scenarios: Scenario[];
  defaults: PublicDefaultsDoc;
  snapshots: CalcSnapshot[];
  conflicts: ConflictEvent[];
  trash: TrashItem[];
  meta: MetaDoc;
};

// ---------- 打开 + 旧库（v1）原地迁移 ----------

interface PendingMigration {
  formulas: Formula[];
  defaults: PublicDefaultsDoc;
  scenario: Scenario;
}

function openDB(): Promise<{ db: IDBDatabase; migration?: PendingMigration }> {
  return new Promise((resolve, reject) => {
    let migration: PendingMigration | undefined;
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const fromV1 = ev.oldVersion < 2 && db.objectStoreNames.contains(S.formulas);
      const t = req.transaction!;

      /** 建新 store（v1 迁移时旧 formulas 已被游标读完并删除） */
      const createStores = () => {
        if (!db.objectStoreNames.contains(S.formulas)) db.createObjectStore(S.formulas, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S.scenarios)) db.createObjectStore(S.scenarios, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S.defaults)) db.createObjectStore(S.defaults, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S.snapshots)) db.createObjectStore(S.snapshots, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S.conflicts)) db.createObjectStore(S.conflicts, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S.trash)) db.createObjectStore(S.trash, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S.meta)) db.createObjectStore(S.meta, { keyPath: "id" });
      };

      if (fromV1) {
        // v1 → v2：必须在同一升级事务内先“游标读完”旧 formulas，再删除它，
        // 绝不能在游标还在 continue() 时同步 deleteObjectStore（会令升级事务中止）。
        const legacyRows: Array<{
          id: string; latex: string; note: string; targetUnit: string;
          createdAt: number; variables: Record<string, VariableDef>;
        }> = [];
        const oldStore = t.objectStore(S.formulas);
        oldStore.openCursor().onsuccess = (ce) => {
          const cur = (ce.target as IDBRequest<IDBCursorWithValue>).result;
          if (cur) {
            const v = cur.value as Partial<{
              id: unknown; latex: unknown; note: unknown; targetUnit: unknown;
              createdAt: unknown; variables: unknown;
            }>;
            if (v && typeof v.latex === "string") {
              legacyRows.push({
                id: typeof v.id === "string" ? v.id : newId(),
                latex: v.latex,
                note: typeof v.note === "string" ? v.note : "",
                targetUnit: typeof v.targetUnit === "string" ? v.targetUnit : "",
                createdAt: typeof v.createdAt === "number" ? v.createdAt : Date.now(),
                variables: sanitizeVarDefs(v.variables),
              });
            }
            cur.continue();
            return;
          }

          // 游标已穷尽：此刻删除旧 formulas，建立 v2 全部 store，并迁移数据
          db.deleteObjectStore(S.formulas);
          createStores();

          const now = Date.now();
          const union: Record<string, VariableDef> = {};
          for (const row of legacyRows) {
            for (const [k, v] of Object.entries(row.variables)) {
              if (!union[k]) union[k] = { ...v };
              else {
                if (!union[k].value && v.value) union[k].value = v.value;
                if (!union[k].unit && v.unit) union[k].unit = v.unit;
              }
            }
          }
          const defaults = makeDefaults(union, now);
          defaults.origin = `由旧版（v1，无工况概念）笔记本迁移生成 · ${new Date(now).toLocaleString()}`;
          const scenario = makeDefaultScenario(now);
          scenario.origin = `默认工况：由旧版笔记本迁移自动生成（修订号从 ${scenario.rev} 起）`;
          scenario.variables = {};

          const fStore = t.objectStore(S.formulas);
          for (const row of legacyRows) {
            fStore.add({
              id: row.id,
              latex: row.latex,
              note: row.note,
              targetUnit: row.targetUnit,
              createdAt: row.createdAt,
              updatedAt: now,
              legacyVariables: row.variables,
              legacyOrigin: `旧版笔记本（v1）公式自带赋值，迁移于 ${new Date(now).toLocaleString()}`,
            });
          }
          t.objectStore(S.scenarios).add(scenario);
          t.objectStore(S.defaults).add(defaults);
          t.objectStore(S.meta).add({ id: "meta", activeScenarioId: scenario.id });
          migration = {
            formulas: legacyRows.map((r) => ({
              id: r.id, latex: r.latex, note: r.note, targetUnit: r.targetUnit,
              createdAt: r.createdAt, updatedAt: now,
              legacyVariables: r.variables,
              legacyOrigin: `旧版笔记本（v1）公式自带赋值，迁移于 ${new Date(now).toLocaleString()}`,
            })),
            defaults, scenario,
          };
        };
        return;
      }

      // 非 v1（全新库或未来版本升级）：建缺失的 store
      createStores();
      if (ev.oldVersion === 0) {
        // 全新数据库：在唯一的升级事务内写入引导数据（避免多标签页 /
        // React StrictMode 双重加载时并发 add 造成 ConstraintError）
        const now = Date.now();
        t.objectStore(S.scenarios).add(makeDefaultScenario(now));
        t.objectStore(S.defaults).add(makeDefaults({}, now));
        t.objectStore(S.meta).add({ id: "meta", activeScenarioId: DEFAULT_SCENARIO_ID });
      }
    };
    req.onsuccess = () => resolve({ db: req.result, migration });
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("数据库被其他标签页占用，请关闭旧标签页后重试"));
  });
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- 读取 ----------

export async function loadState(): Promise<NotebookState> {
  const { db, migration } = await openDB();
  try {
    if (migration) {
      // 升级事务已完成写入，直接返回迁移结果，再补读其余 store
      const state = await readAll(db);
      if (!state.formulas.length && migration.formulas.length) state.formulas = migration.formulas;
      return state;
    }
    return await readAll(db);
  } finally {
    db.close();
  }
}

async function readAll(db: IDBDatabase): Promise<NotebookState> {
  const t = db.transaction(
    [S.formulas, S.scenarios, S.defaults, S.snapshots, S.conflicts, S.trash, S.meta],
    "readonly",
  );
  const formulas = (await reqDone(t.objectStore(S.formulas).getAll() as IDBRequest<Formula[]>) as unknown as Formula[]);
  let scenarios = await reqDone(t.objectStore(S.scenarios).getAll() as IDBRequest<Scenario[]>) as unknown as Scenario[];
  let defaults = (await reqDone(t.objectStore(S.defaults).get("defaults")) as unknown as PublicDefaultsDoc | undefined);
  const snapshots = (await reqDone(t.objectStore(S.snapshots).getAll()) as unknown as CalcSnapshot[]);
  const conflicts = (await reqDone(t.objectStore(S.conflicts).getAll()) as unknown as ConflictEvent[]);
  const trash = (await reqDone(t.objectStore(S.trash).getAll()) as unknown as TrashItem[]);
  let meta = (await reqDone(t.objectStore(S.meta).get("meta")) as unknown as MetaDoc | undefined);

  // 引导数据已在数据库升级事务中写入（oldVersion 0→2）。
  // 这里只做防御性兜底（例如被其他工具删空了文档），绝不在并发加载时写库。
  if (!defaults) defaults = makeDefaults({}, Date.now());
  if (scenarios.length === 0) scenarios = [makeDefaultScenario()];
  if (!meta) meta = { id: "meta", activeScenarioId: scenarios[0]?.id ?? DEFAULT_SCENARIO_ID };

  formulas.sort((a, b) => a.createdAt - b.createdAt);
  scenarios.sort((a, b) => a.createdAt - b.createdAt);
  snapshots.sort((a, b) => b.createdAt - a.createdAt);
  conflicts.sort((a, b) => b.detectedAt - a.detectedAt);
  trash.sort((a, b) => b.deletedAt - a.deletedAt);
  return { formulas, scenarios, defaults, snapshots, conflicts, trash, meta };
}

// ---------- 写入：基础 ----------

function withTx<T>(stores: string[], run: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  return openDB().then(({ db }) =>
    new Promise<T>((resolve, reject) => {
      const t = db.transaction(stores as Iterable<string>, "readwrite");
      let result: T;
      Promise.resolve(run(t))
        .then((r) => { result = r; })
        .catch((e) => { try { t.abort(); } catch { /* ignore */ } reject(e); db.close(); });
      t.oncomplete = () => { resolve(result); db.close(); };
      t.onerror = () => { reject(t.error); db.close(); };
      t.onabort = () => { reject(t.error ?? new Error("事务中止")); db.close(); };
    }),
  );
}

export async function putFormula(f: Formula): Promise<void> {
  await withTx([S.formulas], (t) => { t.objectStore(S.formulas).put(f); });
}

export async function deleteFormula(id: string): Promise<void> {
  await withTx([S.formulas], (t) => { t.objectStore(S.formulas).delete(id); });
}

export async function putSnapshot(s: CalcSnapshot): Promise<void> {
  await withTx([S.snapshots], (t) => { t.objectStore(S.snapshots).put(s); });
}

export async function deleteSnapshot(id: string): Promise<void> {
  await withTx([S.snapshots], (t) => { t.objectStore(S.snapshots).delete(id); });
}

export async function setActiveScenario(id: string): Promise<void> {
  await withTx([S.meta], (t) => { t.objectStore(S.meta).put({ id: "meta", activeScenarioId: id }); });
}

// ---------- CAS：工况 / 公共默认 ----------

export interface CasReject {
  ok: false;
  code: "rev-conflict" | "missing" | "invalid";
  remoteRev: number;
  remoteVars: Record<string, unknown>;
  remoteDeleted: boolean;
  message: string;
}
export type CasResult = { ok: true; rev: number } | CasReject;

/**
 * 保存工况（乐观锁）：
 *  - 库中不存在（已被另一标签页删除）→ missing 拒绝；
 *  - 库中 rev !== expectedRev → rev-conflict 拒绝（绝不覆盖对端的单位/数值）；
 *  - 通过则 rev+1，写入并在同一事务追加冲突解决标记（若提供）。
 */
export async function saveScenario(
  id: string,
  expectedRev: number,
  next: (remote: Scenario) => Scenario,
): Promise<CasResult> {
  return withTx<CasResult>([S.scenarios, S.conflicts], (t) =>
    new Promise<CasResult>((resolve) => {
      const store = t.objectStore(S.scenarios);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const remote = getReq.result as Scenario | undefined;
        if (!remote) {
          resolve({
            ok: false, code: "missing", remoteRev: 0, remoteVars: {}, remoteDeleted: true,
            message: "工况已被另一个标签页删除，本次写入被拒绝（草稿已保留）",
          });
          return;
        }
        if (remote.rev !== expectedRev) {
          resolve({
            ok: false, code: "rev-conflict", remoteRev: remote.rev,
            remoteVars: remote.variables as Record<string, unknown>, remoteDeleted: false,
            message: `工况“${remote.name}”已在另一标签页保存到修订 ${remote.rev}（本地基于修订 ${expectedRev}），本次写入被拒绝`,
          });
          return;
        }
        const updated = next(remote);
        store.put(updated);
        resolve({ ok: true, rev: updated.rev });
      };
      getReq.onerror = () => {
        resolve({
          ok: false, code: "invalid", remoteRev: 0, remoteVars: {}, remoteDeleted: false,
          message: getReq.error?.message ?? "读取工况失败",
        });
      };
    }),
  );
}

/** 公共默认变量同样使用 CAS */
export async function saveDefaults(
  expectedRev: number,
  next: (remote: PublicDefaultsDoc) => PublicDefaultsDoc,
): Promise<CasResult> {
  return withTx<CasResult>([S.defaults], (t) =>
    new Promise<CasResult>((resolve) => {
      const store = t.objectStore(S.defaults);
      const getReq = store.get("defaults");
      getReq.onsuccess = () => {
        const remote = getReq.result as PublicDefaultsDoc | undefined;
        if (!remote || remote.rev !== expectedRev) {
          resolve({
            ok: false,
            code: !remote ? "missing" : "rev-conflict",
            remoteRev: remote?.rev ?? 0,
            remoteVars: (remote?.variables ?? {}) as Record<string, unknown>,
            remoteDeleted: !remote,
            message: !remote
              ? "公共默认变量文档缺失，本次写入被拒绝"
              : `公共默认变量已在另一标签页更新到修订 ${remote.rev}（本地基于修订 ${expectedRev}），本次写入被拒绝`,
          });
          return;
        }
        const updated = next(remote);
        store.put(updated);
        resolve({ ok: true, rev: updated.rev });
      };
      getReq.onerror = () => {
        resolve({
          ok: false, code: "invalid", remoteRev: 0, remoteVars: {}, remoteDeleted: false,
          message: getReq.error?.message ?? "读取公共默认变量失败",
        });
      };
    }),
  );
}

// ---------- 工况生命周期 ----------

/** 仅改工况名：CAS 校验修订号，不触碰任何数值/单位字段，成功后 rev+1 */
export async function renameScenario(
  id: string,
  expectedRev: number,
  name: string,
  tabId: string,
): Promise<CasResult> {
  return withTx<CasResult>([S.scenarios], (t) =>
    new Promise<CasResult>((resolve) => {
      const store = t.objectStore(S.scenarios);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const remote = getReq.result as Scenario | undefined;
        if (!remote) {
          resolve({ ok: false, code: "missing", remoteRev: 0, remoteVars: {}, remoteDeleted: true, message: "工况已不存在" });
          return;
        }
        if (remote.rev !== expectedRev) {
          resolve({
            ok: false, code: "rev-conflict", remoteRev: remote.rev,
            remoteVars: remote.variables as Record<string, unknown>, remoteDeleted: false,
            message: `工况已在另一标签页更新到修订 ${remote.rev}，改名被拒绝`,
          });
          return;
        }
        const rev = remote.rev + 1;
        const updated: Scenario = {
          ...remote, name, rev, updatedAt: Date.now(),
          history: [{
            rev, at: Date.now(), tabId, note: `重命名为“${name}”`,
            variables: structuredClone(remote.variables),
          }, ...remote.history].slice(0, 50),
        };
        store.put(updated);
        resolve({ ok: true, rev });
      };
      getReq.onerror = () => resolve({
        ok: false, code: "invalid", remoteRev: 0, remoteVars: {}, remoteDeleted: false,
        message: getReq.error?.message ?? "改名失败",
      });
    }),
  );
}

/** 新建工况（同事务内校验 id 唯一） */
export async function insertScenario(s: Scenario): Promise<void> {
  await withTx([S.scenarios], (t) => { t.objectStore(S.scenarios).add(s); });
}

/** 软删除工况：移入回收站；快照不删除，仅在读取时标记 scenarioMissing */
export async function trashScenario(id: string): Promise<Scenario> {
  return withTx<Scenario>([S.scenarios, S.trash], (t) =>
    new Promise<Scenario>((resolve, reject) => {
      const scStore = t.objectStore(S.scenarios);
      const getReq = scStore.get(id);
      getReq.onsuccess = () => {
        const doc = getReq.result as Scenario | undefined;
        if (!doc) { reject(new Error("工况不存在，可能已被其他标签页删除")); return; }
        const item: TrashItem = {
          id: `trash_${doc.id}`, kind: "scenario", docId: doc.id,
          name: doc.name, deletedAt: Date.now(), doc,
        };
        t.objectStore(S.trash).put(item);
        scStore.delete(id);
        resolve(doc);
      };
      getReq.onerror = () => reject(getReq.error);
    }),
  );
}

/** 恢复工况：若 id 被重新占用则拒绝（不覆盖新工况） */
export async function restoreScenario(trashId: string): Promise<CasResult> {
  return withTx<CasResult>([S.trash, S.scenarios], (t) =>
    new Promise<CasResult>((resolve) => {
      const trStore = t.objectStore(S.trash);
      const getReq = trStore.get(trashId);
      getReq.onsuccess = () => {
        const item = getReq.result as TrashItem | undefined;
        if (!item) {
          resolve({ ok: false, code: "missing", remoteRev: 0, remoteVars: {}, remoteDeleted: true, message: "回收站条目不存在" });
          return;
        }
        const check = t.objectStore(S.scenarios).get(item.docId);
        check.onsuccess = () => {
          if (check.result) {
            resolve({
              ok: false, code: "rev-conflict", remoteRev: (check.result as Scenario).rev,
              remoteVars: (check.result as Scenario).variables as Record<string, unknown>,
              remoteDeleted: false,
              message: `已存在同 id 工况“${(check.result as Scenario).name}”，恢复被拒绝以免覆盖`,
            });
            return;
          }
          t.objectStore(S.scenarios).put(item.doc);
          trStore.delete(trashId);
          resolve({ ok: true, rev: item.doc.rev });
        };
        check.onerror = () => resolve({
          ok: false, code: "invalid", remoteRev: 0, remoteVars: {}, remoteDeleted: false, message: "恢复校验失败",
        });
      };
      getReq.onerror = () => resolve({
        ok: false, code: "invalid", remoteRev: 0, remoteVars: {}, remoteDeleted: false, message: "读取回收站失败",
      });
    }),
  );
}

export async function purgeTrash(trashId: string): Promise<void> {
  await withTx([S.trash], (t) => { t.objectStore(S.trash).delete(trashId); });
}

// ---------- 冲突事件 ----------

export async function addConflict(c: ConflictEvent): Promise<void> {
  await withTx([S.conflicts], (t) => { t.objectStore(S.conflicts).put(c); });
}

export async function updateConflict(id: string, patch: Partial<ConflictEvent>): Promise<void> {
  await withTx([S.conflicts, S.scenarios], (t) =>
    new Promise<void>((resolve, reject) => {
      const store = t.objectStore(S.conflicts);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const cur = getReq.result as ConflictEvent | undefined;
        if (!cur) { resolve(); return; }
        store.put({ ...cur, ...patch });
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    }),
  );
}

// ---------- 整块写入（导入用，同事务） ----------

export async function importBundle(bundle: {
  formulas?: Formula[];
  scenarios?: Scenario[];
  defaults?: PublicDefaultsDoc;
  snapshots?: CalcSnapshot[];
}): Promise<void> {
  await withTx(
    [S.formulas, S.scenarios, S.defaults, S.snapshots],
    (t) => {
      for (const f of bundle.formulas ?? []) t.objectStore(S.formulas).put(f);
      for (const s of bundle.scenarios ?? []) t.objectStore(S.scenarios).put(s);
      if (bundle.defaults) t.objectStore(S.defaults).put(bundle.defaults);
      for (const s of bundle.snapshots ?? []) t.objectStore(S.snapshots).put(s);
    },
  );
}

export async function clearAll(): Promise<void> {
  await withTx(
    [S.formulas, S.scenarios, S.snapshots, S.conflicts, S.trash],
    (t) => {
      for (const name of [S.formulas, S.scenarios, S.snapshots, S.conflicts, S.trash]) {
        t.objectStore(name).clear();
      }
    },
  );
}

export { S as STORES };
