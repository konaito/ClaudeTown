// 最後に開いたターミナルの大きさ。TerminalView（xterm を含む）を読まずに使えるよう、別のファイルに置く（#16）
export const SIZE_KEY = "claude-town.term-size";
/** 最後に開いたターミナルの大きさ。新しい世帯をこの大きさで起動する */
export function lastTermSize(): { cols: number; rows: number } | null {
  try { const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null"); return v?.cols && v?.rows ? v : null; } catch { return null; }
}
