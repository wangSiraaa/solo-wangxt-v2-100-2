// 多标签页修订冲突面板：展示三方（基线/本标签页/对端）值，逐字段选择；绝不静默覆盖
import { useState } from "react";
import type { ConflictEvent } from "../engine/types";

interface Props {
  conflicts: ConflictEvent[];
  onResolve: (id: string, picks: Record<string, "local" | "remote">) => void;
  onDiscard: (id: string) => void;
}

export default function ConflictPanel({ conflicts, onResolve, onDiscard }: Props) {
  const [open, setOpen] = useState(false);
  const active = conflicts.filter((c) => !c.resolved);
  const resolved = conflicts.filter((c) => c.resolved);

  return (
    <section className="conflict-panel">
      <header className="defaults-head" onClick={() => setOpen((o) => !o)}>
        <button type="button" className="collapse-btn">{open ? "▾" : "▸"}</button>
        <strong>修订冲突{active.length > 0 && <span className="conflict-count">{active.length}</span>}</strong>
        <span className="muted small">
          多标签页同时保存同一字段时在此逐字段合并；系统不会静默覆盖任何一方已保存的数值或单位
        </span>
      </header>
      {open && (
        <div className="conflict-body">
          {active.length === 0 && resolved.length === 0 && (
            <p className="muted small">暂无冲突。两个标签页改不同字段会自动合并；改同一字段才需要在此选择。</p>
          )}
          {active.map((c) => <ConflictCard key={c.id} c={c} onResolve={onResolve} onDiscard={onDiscard} />)}
          {resolved.length > 0 && (
            <details className="resolved-list">
              <summary className="muted small">已解决的冲突（{resolved.length}）</summary>
              {resolved.map((c) => (
                <div key={c.id} className="conflict-row resolved">
                  <span>
                    {c.docName} · 基线 r{c.baseRev} → 对端 r{c.remoteRev} ·{" "}
                    {c.resolution === "merged" ? "已逐字段合并" : "已放弃本地草稿"} ·{" "}
                    {new Date(c.resolvedAt ?? c.detectedAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function ConflictCard({ c, onResolve, onDiscard }: {
  c: ConflictEvent;
  onResolve: Props["onResolve"];
  onDiscard: Props["onDiscard"];
}) {
  const [picks, setPicks] = useState<Record<string, "local" | "remote">>({});
  const fieldLabel = c.kind === "defaults" ? "公共默认变量" : `工况“${c.docName}”`;

  return (
    <div className="conflict-card">
      <div className="conflict-title">
        <strong>{c.remoteDeleted ? "工况已被另一标签页删除" : "同字段修订冲突"}</strong>
        <span className="muted small">
          {fieldLabel} · 你的标签页基于修订 r{c.baseRev}，对端已保存到 r{c.remoteRev}
        </span>
      </div>
      {c.remoteDeleted && (
        <p className="err-text small">
          该工况已在另一标签页被删除，你的写入被拒绝。请先在“回收站”恢复工况，再选择字段合并；
          或放弃本地草稿。草稿中的数值/单位完整列在下方，不会丢失。
        </p>
      )}
      <table className="conflict-table">
        <thead>
          <tr>
            <th>变量</th><th>字段</th><th>共同基线 r{c.baseRev}</th>
            <th>本标签页（你的未保存值）</th><th>对端已保存 r{c.remoteRev}</th><th>选择</th>
          </tr>
        </thead>
        <tbody>
          {c.conflicts.length === 0 && (
            <tr>
              <td colSpan={6} className="muted small">
                未检测到同字段内容冲突（可能是删除竞争）。可在下方直接用你的草稿重建或放弃。
              </td>
            </tr>
          )}
          {c.conflicts.map((cf) => {
            const key = `${cf.varName} ${cf.field}`;
            return (
              <tr key={key} className="conflict-row">
                <td className="var-name">{cf.varName}</td>
                <td>{cf.field === "value" ? "数值" : "单位"}</td>
                <td className="base-val">{cf.base ?? <em className="muted">（继承/空）</em>}</td>
                <td className="local-val">{cf.local ?? <em className="muted">（清除覆盖）</em>}</td>
                <td className="remote-val">{cf.remote ?? <em className="muted">（清除覆盖）</em>}</td>
                <td className="pick">
                  <label>
                    <input
                      type="radio"
                      name={c.id + key}
                      checked={picks[key] === "local"}
                      onChange={() => setPicks((p) => ({ ...p, [key]: "local" }))}
                    />
                    本标签页
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={c.id + key}
                      checked={picks[key] === "remote"}
                      onChange={() => setPicks((p) => ({ ...p, [key]: "remote" }))}
                    />
                    对端
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="conflict-actions">
        <button
          type="button"
          disabled={!c.remoteDeleted && c.conflicts.some((cf) => !picks[`${cf.varName} ${cf.field}`])}
          onClick={() => {
            // 无字段冲突（删除竞争）时直接用本地草稿整体提交
            let full: Record<string, "local" | "remote"> = picks;
            if (c.conflicts.length === 0) {
              full = {};
              for (const [k, v] of Object.entries(c.draft)) {
                if (v.value !== undefined) full[`${k} value`] = "local";
                if (v.unit !== undefined) full[`${k} unit`] = "local";
              }
            }
            onResolve(c.id, full);
          }}
        >
          {c.remoteDeleted ? "我已恢复工况，用上述选择合并保存" : "按选择合并保存（双方历史均保留）"}
        </button>
        <button type="button" className="ghost" onClick={() => {
          if (confirm("放弃本标签页未保存的草稿？对端已保存内容不受影响。")) onDiscard(c.id);
        }}>
          放弃本地草稿
        </button>
      </div>
    </div>
  );
}
