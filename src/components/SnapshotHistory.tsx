// 旧计算记录（快照）列表：每条明确标注当时使用的工况名称、工况修订号与公共默认层修订号，
// 即使工况后来被删除/修改、页面刷新，也仍可回看当时的结果与逐字段来源。
import type { CalcSnapshot } from "../engine/types";

interface Props {
  snapshots: CalcSnapshot[];
  /** 当前工况 id：用于标注“与当前选中工况是否一致” */
  currentConditionId: string | null;
}

const STATUS_LABEL = { ok: "已验证", unverified: "未验证", error: "有错误", empty: "空" } as const;

export default function SnapshotHistory({ snapshots, currentConditionId }: Props) {
  if (snapshots.length === 0) return null;
  return (
    <div className="snapshot-history">
      <div className="snap-title">旧计算记录（{snapshots.length}）</div>
      <ul className="snap-list">
        {snapshots.slice(0, 8).map((s) => {
          const same = s.conditionId === currentConditionId;
          return (
            <li key={s.id} className="snap-item">
              <div className="snap-head">
                <span className={`snap-badge status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                <span className="snap-cond">
                  工况：<strong>{s.conditionName}</strong>
                  {same ? <span className="muted small">（当前选中）</span>
                    : <span className="warn-text small">（非当前工况，仍保留当时结果）</span>}
                </span>
                <span className="snap-rev muted small">工况 rev {s.conditionRev} · 默认层 rev {s.defaultsRev}</span>
                <span className="snap-time muted small">{new Date(s.createdAt).toLocaleString()}</span>
              </div>
              <div className="snap-body muted small">
                <span>结果：{s.summary}</span>
                <span className="snap-vars">
                  {Object.entries(s.variables).map(([k, v]) => (
                    <span key={k} className={`snap-var src-${s.fieldSources[k] ?? "missing"}`}
                      title={`来源：${sourceLabel(s.fieldSources[k])}`}>
                      {k}={v.value || "∅"}{v.unit ? ` ${v.unit}` : ""}
                      <em className="snap-src">{sourceLabel(s.fieldSources[k])}</em>
                    </span>
                  ))}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function sourceLabel(s: string | undefined): string {
  return { override: "覆盖", default: "继承", legacy: "遗留", missing: "缺失" }[s ?? "missing"] ?? "缺失";
}
