/** パネルから送った文の出どころ。composer は入力欄、choice は会話の末尾の選択肢のボタン、card はカードのボタン */
export type SendFrom = "composer" | "choice" | "card";

/**
 * 送れた後に入力欄を空にするか（#182）。入力欄から送って、今の入力欄が送った文のままのときだけ空にする。
 * 選択肢とカードのボタンは入力欄を通らないので、打ちかけの文を残す。
 * 送るのを待つ間（Rust の paste_enter の 150ms と IPC の往復）に打ち足した文も残す
 */
export function clearsDraft(from: SendFrom, sent: string, draftNow: string): boolean {
  // / の補完で Enter を押した文は、入力欄が「/名前 」、送る文が trimEnd した「/名前」になる（#304）。末尾の空白は比べない
  return from === "composer" && draftNow.trimEnd() === sent.trimEnd();
}
