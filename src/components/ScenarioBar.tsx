// 工况选择条：切换、新建、重命名、删除；显示修订号与来源
import { useState } from "react";
import type { Scenario } from "../engine/types";

interface Props {
  scenarios: Scenario[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export default function ScenarioBar({ scenarios, activeId, onSelect, onAdd, onRename, onDelete }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const active = scenarios.find((s) => s.id === activeId);

  return (
    <div className="scenario-bar">
      <span className="scn-label">参数工况集：</span>
      <div className="scn-tabs" role="tablist">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === activeId}
            className={`scn-tab ${s.id === activeId ? "active" : ""}`}
            title={s.origin ?? `修订 ${s.rev} · 创建于 ${new Date(s.createdAt).toLocaleString()}`}
            onClick={() => onSelect(s.id)}
          >
            {s.name}
            <span className="rev-badge" title={`修订号 ${s.rev}`}>r{s.rev}</span>
          </button>
        ))}
        {scenarios.length === 0 && (
          <span className="muted small">所有工况均已删除（可在“冲突与回收站”恢复）；公式不会回退为零值，而是提示变量缺失。</span>
        )}
        <button
          type="button" className="mini-btn scn-add"
          onClick={() => { setAdding(true); setNewName(""); }}
        >
          ＋ 新工况
        </button>
      </div>

      {active && (
        <div className="scn-meta">
          {editingId === active.id ? (
            <span className="scn-rename">
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onRename(active.id, editName.trim() || active.name); setEditingId(null); }
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
              <button type="button" className="mini-btn" onClick={() => {
                onRename(active.id, editName.trim() || active.name); setEditingId(null);
              }}>确定</button>
              <button type="button" className="mini-btn" onClick={() => setEditingId(null)}>取消</button>
            </span>
          ) : (
            <>
              <button
                type="button" className="mini-btn"
                title="重命名当前工况"
                onClick={() => { setEditingId(active.id); setEditName(active.name); }}
              >
                重命名
              </button>
              <button
                type="button" className="mini-btn danger"
                title="删除当前工况（移入回收站，可恢复；不影响其他工况与历史快照）"
                onClick={() => {
                  if (confirm(`确定删除工况“${active.name}”吗？\n\n· 工况会移入回收站，可恢复；\n· 历史计算快照仍保留，并标注工况缺失；\n· 不会把任何变量回退为零，也不会影响其他工况。`)) {
                    onDelete(active.id);
                  }
                }}
              >
                删除工况
              </button>
              <span className="scn-origin muted small" title={active.origin}>{active.origin}</span>
            </>
          )}
        </div>
      )}

      {adding && (
        <div className="scn-rename">
          <input
            autoFocus
            placeholder="工况名称，如：满载、故障工况"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onAdd(newName.trim()); setAdding(false); }
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button type="button" className="mini-btn" onClick={() => { onAdd(newName.trim()); setAdding(false); }}>
            创建
          </button>
          <button type="button" className="mini-btn" onClick={() => setAdding(false)}>取消</button>
        </div>
      )}
    </div>
  );
}
