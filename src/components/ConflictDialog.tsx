// 多标签页修订冲突对话框：展示字段级冲突，用户逐字段选择保留本标签页 / 另一标签页的值，
// 或手动合并输入；不同字段的修改已自动合并并明确列出。绝不能静默覆盖任一方。
import { useState } from "react";
import type { FieldValue } from "../engine/types";
import type { FieldConflict } from "../engine/conditions";

export interface PendingConflict {
  /** 冲突针对的工况 id（"__defaults__" 表示公共默认层） */
  targetId: string;
  targetName: string;
  conflicts: FieldConflict[];
  autoMerged: string[];
  /** 另一标签页给出的（自动合并后）建议值 */
  remoteMerged: Record<string, FieldValue>;
  nameConflict?: { local: string; remote: string } | null;
}

interface Props {
  conflict: PendingConflict;
  onCancel: () => void;
  onResolve: (resolution: Record<string, FieldValue>, nameChoice?: { use: "local" | "remote" } | null) => void;
}

type Choice = "local" | "remote" | "manual";

export default function ConflictDialog({ conflict, onCancel, onResolve }: Props) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [manual, setManual] = useState<Record<string, FieldValue>>({});
  const [nameChoice, setNameChoice] = useState<"local" | "remote" | undefined>();

  const field = (key: string): FieldValue => {
    const c = choices[key] ?? "local";
    if (c === "local") return conflict.conflicts.find((x) => x.field === key)!.local ?? { value: "", unit: "" };
    if (c === "remote") return conflict.conflicts.find((x) => x.field === key)!.remote ?? { value: "", unit: "" };
    return manual[key] ?? conflict.conflicts.find((x) => x.field === key)!.local ?? { value: "", unit: "" };
  };

  const allDecided = conflict.conflicts.every((c) => choices[c.field] !== undefined)
    && (!conflict.nameConflict || nameChoice !== undefined);

  const resolve = () => {
    const resolution: Record<string, FieldValue> = { ...conflict.remoteMerged };
    for (const c of conflict.conflicts) resolution[c.field] = field(c.field);
    onResolve(resolution, conflict.nameConflict ? { use: nameChoice! } : null);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal conflict-modal">
        <h2>检测到修订冲突：{conflict.targetName}</h2>
        <p className="muted">
          另一个浏览器标签页已经保存了该工况（修订号更新）。下方字段双方都做了不同修改，
          请逐字段选择如何合并；系统<strong>不会静默覆盖任何一方的单位或数值</strong>。
        </p>

        {conflict.autoMerged.length > 0 && (
          <p className="merge-note ok">
            以下不同字段的修改已自动字段级合并：{conflict.autoMerged.join("、")}
          </p>
        )}

        {conflict.nameConflict && (
          <div className="conflict-name">
            工况名称也被双方修改：
            <label><input type="radio" name="namechoice" checked={nameChoice === "local"}
              onChange={() => setNameChoice("local")} /> 本标签页：「{conflict.nameConflict.local}」</label>
            <label><input type="radio" name="namechoice" checked={nameChoice === "remote"}
              onChange={() => setNameChoice("remote")} /> 另一标签页：「{conflict.nameConflict.remote}」</label>
          </div>
        )}

        <div className="conflict-table">
          <div className="conflict-row conflict-head">
            <span>字段</span><span>本标签页</span><span>另一标签页（已保存）</span><span>合并选择</span>
          </div>
          {conflict.conflicts.map((c) => {
            const choice = choices[c.field] ?? "local";
            return (
              <div className="conflict-row" key={c.field}>
                <span className="var-name">{c.field}</span>
                <span className="conflict-val">{fmtVal(c.local)}</span>
                <span className="conflict-val">{fmtVal(c.remote)}</span>
                <span className="conflict-choice">
                  <label>
                    <input type="radio" name={`cf_${c.field}`} checked={choice === "local"}
                      onChange={() => setChoices((s) => ({ ...s, [c.field]: "local" }))} />
                    用本标签页
                  </label>
                  <label>
                    <input type="radio" name={`cf_${c.field}`} checked={choice === "remote"}
                      onChange={() => setChoices((s) => ({ ...s, [c.field]: "remote" }))} />
                    用另一标签页
                  </label>
                  <label>
                    <input type="radio" name={`cf_${c.field}`} checked={choice === "manual"}
                      onChange={() => {
                        setChoices((s) => ({ ...s, [c.field]: "manual" }));
                        setManual((m) => ({
                          ...m,
                          [c.field]: m[c.field] ?? c.local ?? { value: "", unit: "" },
                        }));
                      }} />
                    手动：
                  </label>
                  {choice === "manual" && (
                    <span className="manual-inputs">
                      <input
                        value={(manual[c.field] ?? c.local ?? { value: "", unit: "" }).value}
                        onChange={(e) => setManual((m) => ({
                          ...m, [c.field]: { ...(m[c.field] ?? c.local ?? { value: "", unit: "" }), value: e.target.value },
                        }))}
                        placeholder="数值"
                      />
                      <input
                        list="unit-suggestions"
                        value={(manual[c.field] ?? c.local ?? { unit: "" }).unit}
                        onChange={(e) => setManual((m) => ({
                          ...m, [c.field]: { ...(m[c.field] ?? c.local ?? { value: "", unit: "" }), unit: e.target.value },
                        }))}
                        placeholder="单位"
                      />
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>取消（保留本地编辑，稍后重试）</button>
          <button type="button" disabled={!allDecided} onClick={resolve}>按上述选择合并并保存</button>
        </div>
      </div>
    </div>
  );
}

function fmtVal(f: FieldValue | undefined): string {
  if (!f || (f.value === "" && f.unit === "")) return "（恢复继承 / 已删除）";
  return `${f.value} ${f.unit}`.trim();
}
