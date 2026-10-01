// 工况集工具栏：切换 / 新建 / 重命名 / 删除（软删除）/ 恢复；显示修订号与继承覆盖统计。
import { useState } from "react";
import type { Condition, Notebook } from "../engine/types";

interface Props {
  notebook: Notebook;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
}

export default function ConditionsBar({ notebook, onSwitch, onCreate, onRename, onDelete, onRestore }: Props) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);

  const active = notebook.conditions.find((c) => c.id === notebook.activeConditionId);
  const activeMissing = notebook.activeConditionId !== null && !active;
  const visible = notebook.conditions.filter((c) => (showDeleted ? true : !c.deleted));

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    onCreate(name);
    setNewName("");
  };

  const startRename = (c: Condition) => {
    setEditingId(c.id);
    setEditName(c.name);
  };
  const commitRename = () => {
    if (editingId && editName.trim()) onRename(editingId, editName.trim());
    setEditingId(null);
  };

  return (
    <div className="conditions-bar">
      <div className="conditions-row">
        <span className="cond-label">参数工况集</span>
        <div className="cond-tabs" role="tablist">
          {visible.map((c) => {
            const isActive = c.id === notebook.activeConditionId;
            const overrideCount = Object.keys(c.overrides).length;
            return (
              <div
                key={c.id}
                className={`cond-tab ${isActive ? "active" : ""} ${c.deleted ? "deleted" : ""}`}
                title={`修订号 rev ${c.rev}；${overrideCount} 个覆盖字段${c.deleted ? "（已删除，可恢复）" : ""}`}
              >
                {editingId === c.id ? (
                  <input
                    className="cond-rename-input"
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="cond-tab-btn"
                    disabled={c.deleted}
                    onClick={() => onSwitch(c.id)}
                  >
                    {c.name}
                    <span className="rev-tag" title="修订号">rev {c.rev}</span>
                    <span className="ov-count" title="覆盖字段数">{overrideCount}</span>
                  </button>
                )}
                {!c.deleted ? (
                  <>
                    <button type="button" className="mini-btn ghost" title="重命名"
                      onClick={() => startRename(c)}>✎</button>
                    <button type="button" className="mini-btn danger" title="删除该工况（软删除，可恢复；不影响其他工况与历史快照）"
                      onClick={() => onDelete(c.id)}>删除</button>
                  </>
                ) : (
                  <button type="button" className="mini-btn" title="恢复该工况"
                    onClick={() => onRestore(c.id)}>恢复</button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="conditions-row cond-actions">
        <input
          className="cond-new-input"
          value={newName}
          placeholder="新工况名称，如：常温 / 满载 / 故障"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
        />
        <button type="button" onClick={create} disabled={!newName.trim()}>＋ 新建工况</button>
        {notebook.conditions.some((c) => c.deleted) && (
          <button type="button" className="ghost" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? "隐藏已删除" : "显示已删除（可恢复）"}
          </button>
        )}
        <span className="defaults-rev muted small">公共默认层 rev {notebook.defaultsRev}</span>
        {active && !active.deleted && (
          <span className="muted small">
            当前：<strong>{active.name}</strong>（{Object.keys(active.overrides).length} 个字段覆盖，其余继承公共默认）
          </span>
        )}
        {activeMissing && (
          <span className="err-text small">当前选中的工况已不存在（可能被其他标签页删除）：历史快照仍可查看，但不会回退为零值；请选择一套工况。</span>
        )}
        {active?.deleted && (
          <span className="err-text small">当前工况已删除：公式不参与计算（不回退零值、不污染其他工况），可恢复或改选其他工况。</span>
        )}
      </div>
    </div>
  );
}
