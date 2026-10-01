// 变量赋值区：列出当前工况下每个变量的取值与来源（继承/覆盖/遗留/缺失）。
//  - 覆盖值：编辑即写入当前工况；可一键“恢复继承”；
//  - 继承值：灰显公共默认，点击“覆盖”后才写入工况；
//  - 缺失值：明确提示未赋值（绝不取零）。
import type { FieldResolution } from "../engine/types";

interface Props {
  /** 公式中识别到的变量名 */
  names: string[];
  /** 解析后的字段（含来源与量纲冲突原因） */
  fields: Record<string, FieldResolution>;
  /** 当前工况是否可编辑（false = 工况缺失/已删除，整表只读） */
  editable: boolean;
  onOverride: (name: string, patch: { value?: string; unit?: string }) => void;
  onReset: (name: string) => void;
  onMakeOverride: (name: string) => void;
}

const SOURCE_META = {
  override: { label: "覆盖", cls: "src-override", title: "该值保存在当前工况中，修改公共默认不会影响它" },
  default: { label: "继承默认", cls: "src-default", title: "该值继承自公共默认变量；修改公共默认会同步更新" },
  legacy: { label: "旧版遗留", cls: "src-legacy", title: "来自旧版笔记中本公式的私有赋值，不会影响其他公式或工况" },
  missing: { label: "未赋值", cls: "src-missing", title: "公共默认与当前工况都没有该变量的值（系统不会自动取零）" },
} as const;

export default function VariableTable({ names, fields, editable, onOverride, onReset, onMakeOverride }: Props) {
  // 已定义但当前公式未引用的变量也保留显示（换公式文本时不丢输入）
  const referenced = new Set(names);
  const extra = Object.keys(fields).filter((k) => !referenced.has(k));
  const rows = [...names, ...extra];

  if (rows.length === 0) {
    return <p className="muted small">该公式中没有需要赋值的变量（只有数字和 π 等常量）。</p>;
  }

  return (
    <div className="var-table">
      <div className="var-row var-head">
        <span>变量</span><span>数值</span><span>单位（留空 = 纯数）</span><span>来源 / 操作</span>
      </div>
      {rows.map((name) => {
        const f = fields[name] ?? { value: "", unit: "", source: "missing" as const };
        const meta = SOURCE_META[f.source];
        const ghost = extra.includes(name);
        const isInherited = f.source === "default";
        const isLegacy = f.source === "legacy";
        return (
          <div
            className={`var-row ${ghost ? "ghost" : ""} srcrow-${f.source} ${f.unitError ? "has-unit-error" : ""}`}
            key={name}
          >
            <span className="var-name" title={ghost ? "当前公式未引用该变量" : undefined}>{name}</span>
            <input
              className="num-input"
              inputMode="decimal"
              placeholder={f.source === "missing" ? "未赋值（不会取零）" : "如 9.81"}
              value={f.value}
              readOnly={!editable || isInherited || isLegacy}
              onChange={(e) => onOverride(name, { value: e.target.value })}
              onFocus={() => { if (isInherited) onMakeOverride(name); }}
            />
            <input
              className="unit-input"
              list="unit-suggestions"
              placeholder="如 m/s^2"
              value={f.unit}
              readOnly={!editable || isInherited || isLegacy}
              onChange={(e) => onOverride(name, { unit: e.target.value })}
              onFocus={() => { if (isInherited) onMakeOverride(name); }}
            />
            <span className="src-cell">
              <span className={`src-badge ${meta.cls}`} title={meta.title}>{meta.label}</span>
              {editable && f.source === "override" && (
                <button type="button" className="mini-btn" title="删除本工况对此变量的覆盖，恢复继承公共默认"
                  onClick={() => onReset(name)}>
                  恢复继承
                </button>
              )}
              {editable && (f.source === "default" || f.source === "legacy") && (
                <button type="button" className="mini-btn" title="在当前工况中单独覆盖该变量"
                  onClick={() => onMakeOverride(name)}>
                  覆盖
                </button>
              )}
              {f.unitError && <span className="unit-error-text" title={f.unitError}>⚠ {f.unitError}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
