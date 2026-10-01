import { useRef } from "react";
import type { Formula } from "./engine/types";
import { newId } from "./storage/id";
import { buildExport, downloadJSON } from "./storage/exchange";
import { useNotebook } from "./state/useNotebook";
import FormulaCard from "./components/FormulaCard";
import ScenarioBar from "./components/ScenarioBar";
import DefaultsEditor from "./components/DefaultsEditor";
import ConflictPanel from "./components/ConflictPanel";
import TrashPanel from "./components/TrashPanel";
import SnapshotList from "./components/SnapshotList";
import UnitSuggestions from "./components/UnitSuggestions";

function makeFormula(partial?: Partial<Formula>): Formula {
  return {
    id: newId("f"),
    latex: "",
    note: "",
    targetUnit: "",
    createdAt: Date.now(),
    ...partial,
  };
}

export default function App() {
  const { api, loaded } = useNotebook();
  const fileRef = useRef<HTMLInputElement>(null);

  if (!loaded || !api) {
    return <div className="app"><p className="muted">正在加载本地笔记…</p></div>;
  }
  const {
    formulas, scenarios, defaults, snapshots, conflicts, trash, meta, activeScenario,
    setNotice, notice,
  } = api;

  // 内置示例：公共默认给“常温”值；“满载”工况覆盖部分字段，切换即可对比
  const addExample = async (kind: "speed" | "unit" | "degC" | "angle" | "dimErr" | "divZero") => {
    const presets: Record<string, {
      formula: Formula;
      defs: Record<string, { value: string; unit: string }>;
      override?: { scn: string; vars: Record<string, { value?: string; unit?: string }> };
    }> = {
      speed: {
        formula: makeFormula({
          latex: "\\frac{S}{T}",
          note: "速度 = 路程/时间：常温/满载切换看单位换算",
          targetUnit: "km/h",
        }),
        defs: { S: { value: "100", unit: "m" }, T: { value: "10", unit: "s" } },
        override: {
          scn: "满载",
          vars: { S: { value: "36", unit: "km" }, T: { value: "1", unit: "h" } },
        },
      },
      unit: {
        formula: makeFormula({
          latex: "v\\cdot t+\\frac{1}{2}a t^{2}",
          note: "匀变速直线运动位移",
          targetUnit: "m",
        }),
        defs: {
          v: { value: "2", unit: "m/s" },
          t: { value: "3", unit: "s" },
          a: { value: "4", unit: "m/s^2" },
        },
      },
      degC: {
        formula: makeFormula({
          latex: "T_1+T_2",
          note: "摄氏度直接相加 —— 应提示偏移温标歧义并标记未验证",
          targetUnit: "",
        }),
        defs: { T_1: { value: "10", unit: "degC" }, T_2: { value: "5", unit: "degC" } },
      },
      angle: {
        formula: makeFormula({
          latex: "\\theta+\\alpha",
          note: "度与弧度相加 —— 量纲兼容，自动换算",
          targetUnit: "deg",
        }),
        defs: { theta: { value: "1", unit: "rad" }, alpha: { value: "180", unit: "deg" } },
      },
      dimErr: {
        formula: makeFormula({
          latex: "(a+b)\\cdot c",
          note: "m 与 kg 相加 —— 应定位到括号内的 + 节点",
          targetUnit: "",
        }),
        defs: {
          a: { value: "1", unit: "m" }, b: { value: "2", unit: "kg" }, c: { value: "3", unit: "" },
        },
      },
      divZero: {
        formula: makeFormula({
          latex: "x/y",
          note: "除零 —— 必须明确报错，不产生 Infinity",
          targetUnit: "",
        }),
        defs: { x: { value: "10", unit: "m" }, y: { value: "0", unit: "s" } },
      },
    };
    const p = presets[kind];
    // 公共默认补齐（不覆盖教师已有值）
    for (const [k, v] of Object.entries(p.defs)) {
      if (!defaults.variables[k]) api.setDefaultVar(k, v.value, v.unit);
    }
    api.addFormula(p.formula);
    if (p.override) {
      let target = scenarios.find((s) => s.name === p.override!.scn);
      if (!target) target = await api.addScenario(p.override.scn);
      const scnId = target.id;
      for (const [name, ov] of Object.entries(p.override.vars)) {
        if (ov.value !== undefined) api.setOverride(scnId, name, "value", ov.value);
        if (ov.unit !== undefined) api.setOverride(scnId, name, "unit", ov.unit);
      }
    }
  };

  const onExport = () => {
    if (formulas.length === 0 && scenarios.length === 0) {
      setNotice("当前没有可导出的公式或工况"); return;
    }
    downloadJSON(buildExport(formulas, scenarios, defaults, snapshots));
  };

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const r = await api.importText(text);
    if (r.imported === 0 && r.errors.length) {
      setNotice(r.errors[0] ?? "导入失败");
      return;
    }
    setNotice(
      `已导入 ${r.imported} 条公式` +
      (r.migrated
        ? "；检测到旧版（无工况）笔记，已生成可追溯的“默认工况（旧版导入）”，旧公式自带值以“旧版自带”标注"
        : "") +
      (r.errors.length ? `；${r.errors.length} 条提示（${r.errors[0]}）` : ""),
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>量纲检查笔记本 · 参数工况集</h1>
        <p className="subtitle">
          本地运行 · 数据仅在本浏览器（IndexedDB）· 同一套公式在「常温 / 满载 / 故障」工况间切换，
          变量按「工况覆盖 &gt; 公共默认 &gt; 旧版自带」分层取值
        </p>
        <div className="actions">
          <button type="button" onClick={() => api.addFormula(makeFormula())}>＋ 新建公式</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={() => addExample("speed")}>示例：速度/工况切换</button>
          <button type="button" className="ghost" onClick={() => addExample("unit")}>示例：单位运算</button>
          <button type="button" className="ghost" onClick={() => addExample("degC")}>示例：摄氏温标</button>
          <button type="button" className="ghost" onClick={() => addExample("angle")}>示例：角度弧度</button>
          <button type="button" className="ghost" onClick={() => addExample("dimErr")}>示例：量纲错误</button>
          <button type="button" className="ghost" onClick={() => void addExample("divZero")}>示例：除零</button>
          <span className="sep" />
          <button type="button" className="ghost" onClick={onExport}>导出 JSON（v2）</button>
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>导入 JSON（旧版/新版）</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {notice && <div className="notice">{notice}</div>}
      </header>

      <ScenarioBar
        scenarios={scenarios}
        activeId={meta.activeScenarioId}
        onSelect={api.selectScenario}
        onAdd={api.addScenario}
        onRename={api.renameScenario}
        onDelete={api.removeScenario}
      />

      <DefaultsEditor defaults={defaults} onSet={api.setDefaultVar} onRemove={api.removeDefaultVar} />

      <ConflictPanel
        conflicts={conflicts}
        onResolve={api.resolveConflictChoice}
        onDiscard={api.discardConflictDraft}
      />

      <TrashPanel
        items={trash}
        onRestore={api.restoreTrash}
        onPurge={api.purgeTrash}
      />

      <SnapshotList snapshots={snapshots} onDelete={api.removeSnapshot} />

      <main>
        {formulas.length === 0 ? (
          <div className="empty-state">
            <p>还没有公式。点击「新建公式」或加载一个示例开始。</p>
            <p className="muted small">
              规则：未赋值变量与除零都会明确报错（不会自动取零）；删除工况不会把变量清零，只会标记“缺值”；
              多标签页改不同字段自动合并、改同一字段会要求逐字段选择，绝不静默覆盖。
            </p>
          </div>
        ) : (
          formulas.map((f, i) => (
            <FormulaCard
              key={f.id}
              formula={f}
              index={i}
              scenario={activeScenario}
              defaults={defaults}
              onChange={(patch) => api.updateFormula(f.id, patch)}
              onDelete={() => void api.removeFormula(f.id)}
              onOverride={api.setOverride}
              onSaveSnapshot={(s) => void api.saveSnapshot(s)}
            />
          ))
        )}
      </main>

      <footer className="footer">
        <p>
          红色 = 明确错误（量纲不兼容、未赋值、除零、语法错误）；橙色 = 超出支持范围，结果未验证。
          蓝色「覆盖」只属于当前工况；灰色「继承」随公共默认更新；历史记录冻结当时工况 id、名称、修订号。
        </p>
      </footer>

      <UnitSuggestions />
    </div>
  );
}
