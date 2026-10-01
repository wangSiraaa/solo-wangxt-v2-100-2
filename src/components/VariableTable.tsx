// 变量赋值区（工况感知）：逐字段显示 继承值（公共默认/旧版自带）/ 覆盖值 / 缺值。
// 工况表中每一格可“覆盖”或“恢复继承”；缺值明确提示，绝不取零。
import type { ResolvedVar } from "../engine/types";
import type { FieldKey } from "../engine/types";

interface Props {
  /** 变量名顺序（公式识别出的优先） */
  names: string[];
  resolved: Record<string, ResolvedVar>;
  /** 当前工况 id（无工况时为 undefined，只读展示） */
  scenarioId?: string;
  onOverride?: (name: string, field: FieldKey, text: string) => void;
  onClearOverride?: (name: string, field: FieldKey) => void;
}

const SOURCE_LABEL: Record<string, { tag: string; cls: string; title: string }> = {
  scenario: { tag: "覆盖", cls: "src-override", title: "本工况覆盖值：仅影响当前工况" },
  default: { tag: "继承·默认", cls: "src-default", title: "继承自公共默认变量；改公共默认会联动更新" },
  legacy: { tag: "旧版自带", cls: "src-legacy", title: "旧版（无工况概念）笔记保留的公式自带值" },
  missing: { tag: "缺值", cls: "src-missing", title: "公共默认与本工况都未提供：参与计算会明确报错，不会取零" },
  public: { tag: "公共默认", cls: "src-default", title: "公共默认变量编辑表" },
};

export default function VariableTable({ names, resolved, scenarioId, onOverride, onClearOverride }: Props) {
  const all = [
    ...names,
    ...Object.keys(resolved).filter((n) => !names.includes(n)),
  ];
  if (all.length === 0) {
    return <p className="muted small">该公式中没有需要赋值的变量（只有数字和 π 等常量）。</p>;
  }

  return (
    <div className="var-table">
      <div className="var-row var-head">
        <span>变量</span><span>数值</span><span>单位（留空 = 纯数）</span><span />
      </div>
      {all.map((name) => {
        const r = resolved[name];
        return (
          <div className="var-row" key={name}>
            <span className="var-name">{name}</span>
            <FieldCell
              name={name} field="value" text={r.value.text} source={r.value.source}
              dimNote={undefined}
              scenarioId={scenarioId}
              onOverride={onOverride} onClearOverride={onClearOverride}
              placeholder="如 9.81"
            />
            <FieldCell
              name={name} field="unit" text={r.unit.text} source={r.unit.source}
              dimNote={r.unit.dimNote}
              scenarioId={scenarioId}
              onOverride={onOverride} onClearOverride={onClearOverride}
              placeholder="如 m/s^2"
              list
            />
            <span />
          </div>
        );
      })}
    </div>
  );
}

function FieldCell(props: {
  name: string;
  field: FieldKey;
  text: string;
  source: ResolvedVar["value"]["source"];
  dimNote?: string;
  scenarioId?: string;
  placeholder: string;
  list?: boolean;
  onOverride?: (name: string, field: FieldKey, text: string) => void;
  onClearOverride?: (name: string, field: FieldKey) => void;
}) {
  const { name, field, text, source, dimNote, scenarioId, placeholder, list } = props;
  const meta = SOURCE_LABEL[source] ?? SOURCE_LABEL.missing;
  const overridden = source === "scenario";
  const editable = !!scenarioId && !!props.onOverride;

  return (
    <span className={`field-cell src-${source}`} title={dimNote ?? meta.title}>
      <input
        className={overridden ? "input-override" : source === "missing" ? "input-missing" : "input-inherit"}
        inputMode={field === "value" ? "decimal" : undefined}
        list={list ? "unit-suggestions" : undefined}
        value={text}
        placeholder={source === "missing" ? "缺值（不会取零）" : placeholder}
        disabled={!editable}
        onChange={(e) => props.onOverride?.(name, field, e.target.value)}
      />
      <span className={`src-tag ${meta.cls}`} title={meta.title}>{meta.tag}</span>
      {overridden && props.onClearOverride && (
        <button
          type="button"
          className="mini-btn inherit-btn"
          title="清除本工况覆盖，恢复继承公共默认"
          onClick={() => props.onClearOverride?.(name, field)}
        >
          ↩继承
        </button>
      )}
      {dimNote && <span className="dim-note" title={dimNote}>⚠量纲</span>}
    </span>
  );
}

export { SOURCE_LABEL };
