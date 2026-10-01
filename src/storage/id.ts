// 通用 id 与标签页标识

export function newId(prefix = "f"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 本标签页稳定标识（会话内），用于修订历史与冲突记录 */
export const TAB_ID: string =
  `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
