/** 確認の画面で、押したキーとフォーカスの場所から、どうするかを決める。null は何もしない */
export type ConfirmKeyAction = "confirm" | "cancel" | null;

/**
 * Esc はやめる。Enter は進めるが、フォーカスが「やめる」ボタンにあるときはやめる（#170）。
 * 止める操作は戻せないので、やめるつもりで Enter を押したときに進めない
 */
export function confirmKeyAction(key: string, focusOnCancel: boolean): ConfirmKeyAction {
  if (key === "Escape") return "cancel";
  if (key === "Enter") return focusOnCancel ? "cancel" : "confirm";
  return null;
}
