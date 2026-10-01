// 量纲检查引擎 + 参数工况集的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
}

// ---------- 参数工况集 ----------

export type FieldKey = "value" | "unit";

/**
 * 字段值的来源：
 * - scenario：当前工况覆盖值
 * * - default：继承公共默认变量
 * - legacy：旧版（无工况）笔记本迁移保留的公式自带值
 * - missing：所有层都缺，公式应报“未赋值”，绝不取零
 * - public：公共默认变量编辑表自身
 */
export type FieldSource = "scenario" | "default" | "legacy" | "missing" | "public";

export interface ResolvedField {
  /** 实际参与计算的文本（缺值时为 ""） */
  text: string;
  source: FieldSource;
  /** 该字段是否在当前工况中被覆盖（source === "scenario"） */
  overridden: boolean;
  /** 覆盖单位与公共默认单位量纲不一致时的说明（仅提示，不改变计算） */
  dimNote?: string;
}

export interface ResolvedVar {
  value: ResolvedField;
  unit: ResolvedField;
  /** 至少一个字段来自旧版自带记录 */
  legacy: boolean;
}

/** 工况内一个变量：只保存“被覆盖的字段”；键缺省 = 该字段继承公共默认 */
export interface ScenarioVar {
  value?: string;
  unit?: string;
}

export interface RevisionEntry {
  /** 修订号（从 1 开始） */
  rev: number;
  at: number;
  tabId: string;
  /** 修订说明（编辑 / 自动合并 / 恢复等） */
  note?: string;
  /** 该版本的变量字段快照（完整覆盖表） */
  variables: Record<string, ScenarioVar>;
}

export interface Scenario {
  id: string;
  name: string;
  /** 当前修订号；每次成功保存 +1（多标签页 CAS 乐观锁） */
  rev: number;
  /** 覆盖表：只含被覆盖的字段 */
  variables: Record<string, ScenarioVar>;
  /** 修订历史（旧版本，含当前版本；新的在前， capped） */
  history: RevisionEntry[];
  createdAt: number;
  updatedAt: number;
  /** 溯源说明，如“由旧版笔记本导入自动生成” */
  origin?: string;
}

/** 公共默认变量文档（单例，同样带修订号与历史） */
export interface PublicDefaultsDoc {
  id: "defaults";
  variables: Record<string, VariableDef>;
  rev: number;
  updatedAt: number;
  history: RevisionEntry[];
  origin?: string;
}

/** 一条公式（v2：变量值不再挂在公式上，由“公共默认 + 当前工况覆盖”解析） */
export interface Formula {
  id: string;
  /** MathLive 编辑产出的 LaTeX，导出后仍可重新编辑 */
  latex: string;
  note: string;
  /** 期望换算到的结果单位；留空表示使用计算得到的单位 */
  targetUnit: string;
  createdAt: number;
  updatedAt?: number;
  /**
   * 旧版（无工况概念）笔记迁移时，为“与公共默认冲突”的变量保留的公式自带值。
   * 解析优先级：工况覆盖 > 公共默认 > legacyVariables。
   * 仅在公共默认中不存在该变量键时兜底，保证旧公式永远按原值计算。
   */
  legacyVariables?: Record<string, VariableDef>;
  legacyOrigin?: string;
}

/** 冻结的计算快照：旧记录必须能说明当时用的哪套工况、哪个修订 */
export interface CalcSnapshot {
  id: string;
  formulaId: string;
  formulaLatex: string;
  formulaNote: string;
  createdAt: number;
  tabId: string;
  /** 当时的三段展示与计算结果（冻结，引擎升级也不重算） */
  analysis: AnalysisResult;
  targetUnit: string;
  // 溯源
  scenarioId: string;
  scenarioName: string;
  scenarioRev: number;
  defaultsRev: number;
  /** 当时实际参与计算的完整变量与来源 */
  vars: Record<string, { value: string; unit: string; source: FieldSource }>;
  /** 对应工况后来被删除时标记（快照内容仍完整保留） */
  scenarioMissing?: boolean;
  formulaDeleted?: boolean;
}

/** 字段级冲突描述 */
export interface FieldConflict {
  varName: string;
  field: FieldKey;
  base: string | undefined;
  local: string | undefined;
  remote: string | undefined;
}

/** 多标签页保存被拒时留下的冲突记录（含完整本地草稿，绝不丢失） */
export interface ConflictEvent {
  id: string;
  kind: "scenario" | "defaults";
  /** scenario id；defaults 文档固定为 "defaults" */
  docId: string;
  docName: string;
  detectedAt: number;
  tabId: string;
  baseRev: number;
  remoteRev: number;
  /** 本地编辑所基于的字段表（三方合并的 base） */
  baseVars: Record<string, ScenarioVar>;
  /** 被拒绝保存的本地完整草稿 */
  draft: Record<string, ScenarioVar>;
  /** 对端当时的完整字段表（用于解决冲突） */
  remoteVars: Record<string, ScenarioVar>;
  conflicts: FieldConflict[];
  /** 对端工况是否已被删除（恢复工况或放弃草稿二选一） */
  remoteDeleted?: boolean;
  resolved: boolean;
  resolvedAt?: number;
  resolution?: "merged" | "discarded-local";
}

/** 回收站条目（工况软删除，可恢复；快照永不进回收站） */
export interface TrashItem {
  id: string;
  kind: "scenario";
  docId: string;
  name: string;
  deletedAt: number;
  doc: Scenario;
}

export interface MetaDoc {
  id: "meta";
  activeScenarioId: string;
}

// ---------- 分析结果 ----------

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
