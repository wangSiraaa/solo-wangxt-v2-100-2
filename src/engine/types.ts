// 量纲分析引擎与工况集的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
}

/** 工况/默认层中一个变量字段的取值（字符串原样保存，不做数值隐式转换） */
export interface FieldValue {
  value: string;
  unit: string;
}

/** 某字段在当前工况下的取值来源（供 UI 显示继承/覆盖/缺失） */
export type FieldSource = "override" | "default" | "legacy" | "missing";

export interface FieldResolution extends FieldValue {
  source: FieldSource;
  /** override 字段首次被覆盖时的工况修订号 */
  overrideRev?: number;
  /** 该字段在当前工况下的量纲检查结论 */
  unitError?: string;
}

/** 一条公式（新版中变量值不再存于公式本身，而是由工况集统一管理） */
export interface Formula {
  id: string;
  /** MathLive 编辑产出的 LaTeX，导出后仍可重新编辑 */
  latex: string;
  /** 备注 */
  note: string;
  /** 期望换算到的结果单位；留空表示使用计算得到的单位 */
  targetUnit: string;
  createdAt: number;
  /**
   * 旧版（无工况概念）笔记遗留的变量赋值。
   * 仅作为该公式自身的最后回退，绝不写入任何工况、绝不影响其他公式。
   * 新公式/新导入不产生此字段。
   */
  legacyVariables?: Record<string, VariableDef>;
}

/**
 * 参数工况集（常温 / 满载 / 故障…）。
 * 每个字段独立覆盖公共默认变量；未覆盖的字段继承默认值，
 * 因此公共默认更新后只会影响未覆盖字段。
 */
export interface Condition {
  id: string;
  name: string;
  /** 修订号：每次字段/名称被保存即 +1，用于多标签页乐观并发检测 */
  rev: number;
  /** 覆盖字段：仅保存“与默认不同”的值与单位 */
  overrides: Record<string, FieldValue>;
  /** 每个覆盖字段首次写入时的修订号（用于溯源“何时覆盖”） */
  overrideRevs: Record<string, number>;
  /** 备注 */
  description: string;
  createdAt: number;
  updatedAt: number;
  /** 软删除标记：历史快照仍引用该工况，可恢复；删除期间不参与计算 */
  deleted?: boolean;
  deletedAt?: number;
}

/** 整本笔记（IndexedDB 中单条 key="main" 的记录） */
export interface Notebook {
  id: "main";
  /** 公共默认变量（所有工况未覆盖时的继承来源） */
  defaults: Record<string, FieldValue>;
  /** 默认变量层的修订号 */
  defaultsRev: number;
  /** 工况集（含软删除项，按创建顺序排列） */
  conditions: Condition[];
  /** 当前选中工况 id；可能指向已删除/不存在的工况（此时 UI 提示而非回退零值） */
  activeConditionId: string | null;
  /** 笔记结构版本：旧版公式自动迁移后为 2 */
  schemaVersion: 2;
  updatedAt: number;
}

/** 一次计算快照：让旧计算记录始终能说明“当时用了哪套工况、哪个版本” */
export interface CalcSnapshot {
  id: string;
  formulaId: string;
  /** 计算时选中的工况 id（默认工况/旧迁移工况同样记录） */
  conditionId: string;
  conditionName: string;
  /** 计算时工况修订号；默认层修订号；为追溯“哪个版本”而保存 */
  conditionRev: number;
  defaultsRev: number;
  /** 计算时实际使用的变量（解析后：覆盖/默认/遗留逐层得到），原样冻结 */
  variables: Record<string, VariableDef>;
  /** 逐字段来源，可回看哪些值来自覆盖、哪些来自继承 */
  fieldSources: Record<string, FieldSource>;
  latex: string;
  targetUnit: string;
  status: AnalysisStatus;
  summary: string;
  value?: number;
  resultUnit?: string;
  targetValue?: number;
  targetUnitResult?: string;
  source?: string;
  substituted?: string;
  createdAt: number;
}

/** 问题严重级别：error = 明确错误；warning = 超出首版支持范围，结果未验证 */
export type IssueKind = "error" | "warning";

export interface Issue {
  kind: IssueKind;
  /** 定位到的 AST 节点路径（根节点为 []，子节点为序号数组） */
  path: number[];
  /** 该节点对应的原式片段（LaTeX） */
  snippet: string;
  message: string;
}

export type AnalysisStatus = "ok" | "unverified" | "error" | "empty";

export interface AnalysisResult {
  status: AnalysisStatus;
  /** 原式中识别出的变量名（不含 pi、e 等内置常量） */
  variables: string[];
  /** 所有问题（错误 + 未验证警告） */
  issues: Issue[];
  /** 原式对应的 mathjs 表达式 */
  source?: string;
  /** 替换变量后的计算式（mathjs 表达式） */
  substituted?: string;
  /** 原式的 TeX（带问题节点高亮） */
  originalTex?: string;
  /** 替换后计算式的 TeX（带问题节点高亮） */
  substitutedTex?: string;
  /** 结果数值（原始单位） */
  value?: number;
  /** 结果单位字符串，无量纲时为 "" */
  resultUnit?: string;
  /** 换算后的结果数值 */
  targetValue?: number;
  /** 换算后的结果单位 */
  targetUnit?: string;
  /** 给 UI 用的简短状态说明 */
  summary?: string;
}
