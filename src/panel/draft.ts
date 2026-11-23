/** パネルから送った文の出どころ。composer は入力欄、choice は会話の末尾の選択肢のボタン、card はカードのボタン */
export type SendFrom = "composer" | "choice" | "card";

/**
 * 送れた後に入力欄を空にするか（#182）。入力欄から送って、今の入力欄が送った文のままのときだけ空にする。
 * 選択肢とカードのボタンは入力欄を通らないので、打ちかけの文を残す。
 * 送るのを待つ間（Rust の paste_enter の 150ms と IPC の往復）に打ち足した文も残す
 */
export function clearsDraft(from: SendFrom, sent: string, draftNow: string): boolean {
  return from === "composer" && draftNow === sent;
}
