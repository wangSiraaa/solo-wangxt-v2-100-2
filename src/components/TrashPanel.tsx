// 回收站：被删工况可恢复；恢复时若 id 冲突会明确拒绝，不覆盖新工况
import type { TrashItem } from "../engine/types";

interface Props {
  items: TrashItem[];
  onRestore: (trashId: string) => void;
  onPurge: (trashId: string) => void;
}

export default function TrashPanel({ items, onRestore, onPurge }: Props) {
  if (items.length === 0) return null;
  return (
    <section className="trash-panel">
      <header className="defaults-head">
        <strong>回收站（{items.length} 个已删工况）</strong>
        <span className="muted small">软删除：恢复后覆盖值与修订历史原样回来；历史快照也会重新关联</span>
      </header>
      <div className="trash-body">
        {items.map((t) => (
          <div className="trash-row" key={t.id}>
            <span className="trash-name">{t.name}</span>
            <span className="muted small">
              修订 r{t.doc.rev} · 删除于 {new Date(t.deletedAt).toLocaleString()}
              {t.doc.origin ? ` · ${t.doc.origin}` : ""}
            </span>
            <span className="trash-actions">
              <button type="button" className="mini-btn" onClick={() => onRestore(t.id)}>恢复</button>
              <button
                type="button" className="mini-btn danger"
                title="彻底删除（不可恢复；历史快照仍保留但会永久标注工况缺失）"
                onClick={() => {
                  if (confirm(`彻底删除工况“${t.name}”？此操作不可恢复（历史计算快照仍会保留）。`)) onPurge(t.id);
                }}
              >
                彻底删除
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
