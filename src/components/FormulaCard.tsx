// 单条公式卡片：在“当前选中工况”下解析变量 → 三段展示；可冻结计算快照（记录工况与修订号）
import { useMemo, useState } from "react";
import type { CalcSnapshot, FieldKey, Formula, PublicDefaultsDoc, Scenario } from "../engine/types";
import { analyzeFormula } from "../engine/math";
import { resolveFormulaVars } from "../engine/scenarios";
import { makeSnapshot } from "../storage/snapshot";
import MathInput from "./MathInput";
import Tex from "./Tex";
import VariableTable from "./VariableTable";

interface Props {
  formula: Formula;
  index: number;
  scenario?: Scenario;
  defaults: PublicDefaultsDoc;
  onChange: (patch: Partial<Formula>) => void;
  onDelete: () => void;
  onOverride: (scenarioId: string, name: string, field: FieldKey, text: string) => void;
  onSaveSnapshot: (s: CalcSnapshot) => void;
}

const STATUS_META = {
  ok: { label: "已验证", cls: "ok" },
  unverified: { label: "未验证", cls: "warn" },
  error: { label: "有错误", cls: "err" },
  empty: { label: "空公式", cls: "empty" },
} as const;

export default function FormulaCard({
  formula, index, scenario, defaults, onChange, onDelete, onOverride, onSaveSnapshot,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  // 先用一次最小分析拿到变量名，再做工况解析；最终用解析后的完整变量表计算
  const varNames = useMemo(() => {
    if (!formula.latex.trim()) return [];
    return analyzeFormula(formula.latex, {}, "").variables;
  }, [formula.latex]);

  const { defs, resolved } = useMemo(
    () => resolveFormulaVars(formula, varNames, scenario, defaults),
    [formula, varNames, scenario, defaults],
  );

  const result = useMemo(
    () => analyzeFormula(formula.latex, defs, formula.targetUnit),
    [formula.latex, defs, formula.targetUnit],
  );
  const meta = STATUS_META[result.status];

  return (
    <section className={`card status-${meta.cls}`} data-formula-id={formula.id} data-note={formula.note}>
      <header className="card-head">
        <button type="button" className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "▸" : "▾"}
        </button>
        <strong>公式 {index + 1}</strong>
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
        <span className="summary">{result.summary}</span>
        {scenario && (
          <span className="card-scn" title="当前计算所用工况及其修订号">
            {scenario.name} · r{scenario.rev}
          </span>
        )}
        <button
          type="button"
          className="mini-btn"
          title="把当前工况下的计算结果存为历史记录（冻结，记录工况与修订号）"
          disabled={result.status === "empty" || !scenario}
          onClick={() => onSaveSnapshot(makeSnapshot(formula, result.variables, scenario, defaults))}
        >
          ◷ 存为历史记录
        </button>
        <button type="button" className="mini-btn danger" onClick={onDelete} title="删除此公式（其历史快照仍保留）">
          删除
        </button>
      </header>

      {!collapsed && (
        <div className="card-body">
          <label className="field-label">
            输入表达式（支持 + − × ÷、幂、分数、括号；变量用字母或下标，如 <code>v</code>、<code>x_1</code>、<code>θ</code>）
            <MathInput
              value={formula.latex}
              onChange={(latex) => onChange({ latex })}
              placeholder="例如  v \cdot t + \frac{1}{2} a t^2"
            />
          </label>

          {formula.legacyOrigin && (
            <p className="legacy-banner" title={formula.legacyOrigin}>
              旧版公式：{formula.legacyOrigin}（与公共默认不一致的字段以“旧版自带”标注）
            </p>
          )}

          <div className="grid-2">
            <div>
              <div className="field-label">
                变量赋值（工况：{scenario ? scenario.name : "无"}）
                <span className="muted small inline-hint">
                  灰字 = 继承公共默认/旧版自带；深框 = 本工况覆盖；缺值会报错，绝不取零
                </span>
              </div>
              <VariableTable
                names={result.variables}
                resolved={resolved}
                scenarioId={scenario?.id}
                onOverride={(n, f, t) => scenario && onOverride(scenario.id, n, f, t)}
                onClearOverride={(n, f) => scenario && onOverride(scenario.id, n, f, "")}
              />
            </div>
            <div>
              <label className="field-label">
                结果目标单位（可选；用于常用单位换算，如 K、degF、deg、rad、km/h）
                <input
                  className="unit-result-input"
                  list="unit-suggestions"
                  value={formula.targetUnit}
                  placeholder="自动（保留计算单位）"
                  onChange={(e) => onChange({ targetUnit: e.target.value })}
                />
              </label>
              <label className="field-label">
                备注
                <input
                  value={formula.note}
                  placeholder="例如：自由落体位移"
                  onChange={(e) => onChange({ note: e.target.value })}
                />
              </label>
            </div>
          </div>

          {result.source !== undefined && (
            <div className="display-area">
              <div className="display-row">
                <span className="row-tag">原式</span>
                <div className="tex-box">{result.originalTex ? <Tex tex={result.originalTex} /> : <span className="muted">—</span>}</div>
              </div>
              <div className="display-row">
                <span className="row-tag">代入后计算式</span>
                <div className="tex-box">
                  {result.substitutedTex ? (
                    <>
                      <Tex tex={result.substitutedTex} />
                      {result.status !== "ok" && (
                        <span className="muted small">（未赋值或出错处保留符号）</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
              </div>
              <div className="display-row result-row">
                <span className="row-tag">结果</span>
                <div className="tex-box">
                  {result.status === "ok" || result.status === "unverified" ? (
                    <div>
                      {result.value !== undefined && (
                        <div className="result-line">
                          <Tex tex={`= ${fmt(result.value)}${result.resultUnit ? `~${toTexUnit(result.resultUnit)}` : ""}`} />
                        </div>
                      )}
                      {result.targetValue !== undefined && (
                        <div className="result-line converted">
                          <Tex tex={`= ${fmt(result.targetValue)}~${toTexUnit(result.targetUnit ?? "")}`} />
                          <span className="muted small">（按目标单位换算）</span>
                        </div>
                      )}
                      {result.status === "unverified" && <div className="warn-text">{result.summary}</div>}
                    </div>
                  ) : (
                    <span className="err-text">{result.summary}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {result.issues.length > 0 && (
            <ul className="issue-list">
              {result.issues.map((iss, i) => (
                <li key={i} className={`issue ${iss.kind}`}>
                  <span className={`dot ${iss.kind}`} />
                  <span className="issue-kind">{iss.kind === "error" ? "错误" : "未验证"}</span>
                  <span className="issue-msg">{iss.message}</span>
                  <span className="issue-snippet">
                    定位：<Tex tex={iss.snippet || "·"} block={false} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
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

// mathjs 单位文本（m / s^2）→ 简单 TeX（\mathrm{m}/\mathrm{s}^{2}）
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
