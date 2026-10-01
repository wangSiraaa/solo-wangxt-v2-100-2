// 历史计算快照：冻结的三段展示与结果，附工况 id/名称/修订号、公共默认修订号、逐变量来源。
// 快照永不重算：工况删除、变量缺失、单位变化都不会改变它，也不会被污染。
import { useState } from "react";
import type { CalcSnapshot } from "../engine/types";
import Tex from "./Tex";

interface Props {
  snapshots: CalcSnapshot[];
  onDelete: (id: string) => void;
}

export default function SnapshotList({ snapshots, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  if (snapshots.length === 0) return null;

  return (
    <section className="snapshot-panel">
      <header className="defaults-head" onClick={() => setOpen((o) => !o)}>
        <button type="button" className="collapse-btn">{open ? "▾" : "▸"}</button>
        <strong>历史计算记录（{snapshots.length}）</strong>
        <span className="muted small">冻结快照：记录当时的工况与修订号，刷新页面、删除/恢复工况后都不变</span>
      </header>
      {open && (
        <div className="snapshot-body">
          {snapshots.map((s) => <SnapshotCard key={s.id} s={s} onDelete={() => onDelete(s.id)} />)}
        </div>
      )}
    </section>
  );
}

function SnapshotCard({ s, onDelete }: { s: CalcSnapshot; onDelete: () => void }) {
  const a = s.analysis;
  return (
    <article className={`snapshot-card snap-${a.status}`}>
      <header className="snap-head">
        <span className="snap-note">{s.formulaNote || "（无备注公式）"}{s.formulaDeleted && <em className="snap-deleted"> · 公式已删除</em>}</span>
        <span className="snap-time">{new Date(s.createdAt).toLocaleString()}</span>
        <button type="button" className="mini-btn danger" onClick={onDelete}>删除记录</button>
      </header>
      <div className="snap-provenance">
        <span className="prov-tag">工况：
          <strong>{s.scenarioName}</strong>
          {s.scenarioMissing && <em className="snap-missing">（该工况已删除，快照仍保留）</em>}
        </span>
        <span className="prov-tag">工况修订：<strong>r{s.scenarioRev}</strong></span>
        <span className="prov-tag">公共默认修订：<strong>r{s.defaultsRev}</strong></span>
        <span className="prov-tag">目标单位：<strong>{s.targetUnit || "自动"}</strong></span>
      </div>
      <div className="display-area">
        <div className="display-row">
          <span className="row-tag">原式（冻结）</span>
          <div className="tex-box">{a.originalTex ? <Tex tex={a.originalTex} /> : <code>{s.formulaLatex}</code>}</div>
        </div>
        <div className="display-row">
          <span className="row-tag">代入计算式</span>
          <div className="tex-box">{a.substitutedTex ? <Tex tex={a.substitutedTex} /> : <span className="muted">—</span>}</div>
        </div>
        <div className="display-row result-row">
          <span className="row-tag">当时结果</span>
          <div className="tex-box">
            {a.value !== undefined && (
              <span className="result-line">
                <Tex
                  block={false}
                  tex={`= ${fmt(a.value)}${a.resultUnit ? `~${toTexUnit(a.resultUnit)}` : ""}`}
                />
              </span>
            )}
            {a.targetValue !== undefined && (
              <span className="result-line converted">
                <Tex block={false} tex={`= ${fmt(a.targetValue)}~${toTexUnit(a.targetUnit ?? "")}`} />
              </span>
            )}
            <span className={`snap-status status-${a.status}`}>{a.summary}</span>
          </div>
        </div>
      </div>
      <details className="snap-vars">
        <summary className="muted small">当时参与计算的变量与来源（{Object.keys(s.vars).length}）</summary>
        <table className="snap-var-table">
          <tbody>
            {Object.entries(s.vars).map(([name, v]) => (
              <tr key={name}>
                <td className="var-name">{name}</td>
                <td>{v.value || <em className="muted">缺值</em>}</td>
                <td>{v.unit || <em className="muted">纯数</em>}</td>
                <td><SourceTag source={v.source} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </article>
  );
}

function SourceTag({ source }: { source: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    scenario: { label: "工况覆盖", cls: "src-override" },
    default: { label: "继承公共默认", cls: "src-default" },
    legacy: { label: "旧版自带", cls: "src-legacy" },
    missing: { label: "缺值（未取零）", cls: "src-missing" },
  };
  const m = map[source] ?? { label: source, cls: "src-missing" };
  return <span className={`src-tag ${m.cls}`}>{m.label}</span>;
}

function fmt(n: number | undefined): string {
  if (n === undefined) return "";
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    const [m, e] = n.toExponential(6).split("e");
    return `${m.replace(/\.?0+$/, "")}\\times10^{${Number(e)}}`;
  }
  return String(Number(n.toFixed(10)));
}

function toTexUnit(unit: string): string {
  if (!unit) return "";
  const parts = unit.split(/\s*\/\s*/);
  const encode = (seg: string) =>
    seg.split(/\s+/).map((factor) => {
      const pow = factor.split("^");
      const base = `\\mathrm{${pow[0]}}`;
      return pow.length > 1 ? `${base}^{${pow[1]}}` : base;
    }).join("\\,");
  if (parts.length === 1) return encode(parts[0]);
  return `${encode(parts[0])}/${parts.slice(1).map(encode).join("/")}`;
}
