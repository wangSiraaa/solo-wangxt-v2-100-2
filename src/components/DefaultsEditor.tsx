// 公共默认变量编辑器：所有工况未覆盖字段的继承来源。
import { useState } from "react";
import type { FieldValue } from "../engine/types";

interface Props {
  defaults: Record<string, FieldValue>;
  /** 所有公式中出现过的变量名（便于一键加入公共默认） */
  knownNames: string[];
  warnings: string[];
  onChange: (name: string, patch: Partial<FieldValue>) => void;
  onRemove: (name: string) => void;
}

export default function DefaultsEditor({ defaults, knownNames, warnings, onChange, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const names = Object.keys(defaults);
  const missingKnown = knownNames.filter((n) => !(n in defaults));

  return (
    <div className="defaults-editor">
      <button type="button" className="ghost defaults-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} 公共默认变量（{names.length}）—— 修改后只影响各工况“未覆盖”的字段
      </button>
      {open && (
        <div className="defaults-body">
          <div className="var-table">
            <div className="var-row var-head">
              <span>变量</span><span>默认数值</span><span>默认单位</span><span />
            </div>
            {names.map((name) => (
              <div className="var-row" key={name}>
                <span className="var-name">{name}</span>
                <input
                  className="num-input"
                  value={defaults[name].value}
                  onChange={(e) => onChange(name, { value: e.target.value })}
                />
                <input
                  className="unit-input"
                  list="unit-suggestions"
                  value={defaults[name].unit}
                  onChange={(e) => onChange(name, { unit: e.target.value })}
                />
                <span className="src-cell">
                  <button type="button" className="mini-btn danger" title="删除该公共默认（未覆盖工况会变为未赋值，而不是零）"
                    onClick={() => onRemove(name)}>
                    删除
                  </button>
                </span>
              </div>
            ))}
            {names.length === 0 && (
              <p className="muted small" style={{ padding: 8 }}>还没有公共默认变量。添加后，各工况默认继承它们。</p>
            )}
          </div>

          <div className="defaults-add">
            <input
              value={newName}
              placeholder="变量名，如 m（质量）"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) { onChange(newName.trim(), { value: "", unit: "" }); setNewName(""); }
              }}
            />
            <button type="button" disabled={!newName.trim()}
              onClick={() => { onChange(newName.trim(), { value: "", unit: "" }); setNewName(""); }}>
              ＋ 添加默认变量
            </button>
            {missingKnown.length > 0 && (
              <span className="muted small">
                公式中尚未设默认值的变量：
                {missingKnown.map((n) => (
                  <button key={n} type="button" className="mini-btn" style={{ marginLeft: 4 }}
                    onClick={() => onChange(n, { value: "", unit: "" })}>
                    {n}
                  </button>
                ))}
              </span>
            )}
          </div>

          {warnings.length > 0 && (
            <ul className="issue-list">
              {warnings.map((w, i) => (
                <li className="issue warning" key={i}>
                  <span className="dot warning" />
                  <span className="issue-msg">{w}（该覆盖值不会被静默修改，已在对应工况中标红）</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
