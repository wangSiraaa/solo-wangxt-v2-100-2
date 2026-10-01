// 公共默认变量编辑表：所有工况未覆盖的字段都从这里继承。
// 更新公共默认只影响“未覆盖字段”；工况中已覆盖的数值/单位保持不变。
import { useState } from "react";
import type { PublicDefaultsDoc } from "../engine/types";

interface Props {
  defaults: PublicDefaultsDoc;
  onSet: (name: string, value: string, unit: string) => void;
  onRemove: (name: string) => void;
}

export default function DefaultsEditor({ defaults, onSet, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const entries = Object.entries(defaults.variables);

  return (
    <section className="defaults-panel">
      <header className="defaults-head" onClick={() => setOpen((o) => !o)}>
        <button type="button" className="collapse-btn">{open ? "▾" : "▸"}</button>
        <strong>公共默认变量</strong>
        <span className="muted small">
          所有工况共享的默认值/单位（修订 r{defaults.rev}）· 工况未覆盖的字段继承此处；改这里不会动已覆盖字段
        </span>
      </header>
      {open && (
        <div className="defaults-body">
          {defaults.origin && <p className="muted small origin-line">来源：{defaults.origin}</p>}
          <div className="var-table">
            <div className="var-row var-head">
              <span>变量</span><span>默认数值</span><span>默认单位</span><span />
            </div>
            {entries.length === 0 && (
              <div className="var-row"><span className="muted small" style={{ gridColumn: "1 / -1" }}>
                还没有公共默认变量。在公式变量表里覆盖，或在此添加。
              </span></div>
            )}
            {entries.map(([n, v]) => (
              <div className="var-row" key={n}>
                <span className="var-name">{n}</span>
                <input
                  className="num-input"
                  inputMode="decimal"
                  value={v.value}
                  onChange={(e) => onSet(n, e.target.value, v.unit)}
                />
                <input
                  className="unit-input"
                  list="unit-suggestions"
                  value={v.unit}
                  onChange={(e) => onSet(n, v.value, e.target.value)}
                />
                <button
                  type="button" className="mini-btn danger"
                  title="删除公共默认变量（依赖它且未覆盖的工况会变为“缺值”，不会取零）"
                  onClick={() => onRemove(n)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="defaults-add">
            <input className="d-name" placeholder="变量名，如 m" value={name}
              onChange={(e) => setName(e.target.value)} />
            <input className="d-value" placeholder="数值，如 10" inputMode="decimal" value={value}
              onChange={(e) => setValue(e.target.value)} />
            <input className="d-unit" placeholder="单位，如 kg" list="unit-suggestions" value={unit}
              onChange={(e) => setUnit(e.target.value)} />
            <button type="button" className="mini-btn" onClick={() => {
              const key = name.trim();
              if (!key) return;
              onSet(key, value, unit);
              setName(""); setValue(""); setUnit("");
            }}>添加/更新</button>
          </div>
        </div>
      )}
    </section>
  );
}
