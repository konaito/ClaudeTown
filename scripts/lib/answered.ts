// compare-fullscreen.ts の「答えた」の判定（#211）。
// 依頼文に「40」が入っているので、出力のどこかに 40 があるかでは判定できない。
// 入力欄に打った依頼文が画面に返った時点で真になってしまう。
// そこで、依頼を送った後の出力から制御列を除き、行頭が 39 の行のあとに行頭が 40 の行があるかを見る。
// 40 の行だけでは決めない。カーソルを動かした先に描かれた「40 tokens」のような表示も行頭に来るため。
export const PROMPT = "ツールは使わずに答えて。1から40まで、1行に1つずつ、数字と短い一言を書いて。";

// CSI（ESC [ … 終端）、OSC（ESC ] … BEL か ST）、そのほかの2バイトの ESC 列
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[\s\S]/g;

/**
 * 端末への出力を、見える文字の行に分ける。色や太字（CSI … m）、OSC、そのほかの ESC 列は消す。
 * カーソルを右へ送る列（CSI … C）は空白にし、それ以外の CSI はカーソルの移動や消去なので行の切れ目にする。
 */
export function plainLines(text: string): string[] {
  const plain = text.replace(ESCAPES, (seq) => {
    if (!seq.startsWith("\x1b[")) return "";
    const end = seq[seq.length - 1];
    return end === "m" ? "" : end === "C" ? " " : "\n";
  });
  return plain.split(/[\r\n]+/);
}

// 行頭の飾り（⏺ や箇条書きの記号）のあとに n があり、続きが区切りの記号か空白か行末
const numbered = (n: number) => new RegExp(`^\\s*(?:[⏺●•*-]\\s*)?${n}(?:[.．:：、)）]|\\s|$)`);
const LINE_39 = numbered(39), LINE_40 = numbered(40);

/** 依頼を送った後の出力 after に、39 で始まる行と、その後に答えの最後の行（40. や 40 で始まる行）があるか */
export function answered(after: string): boolean {
  const lines = plainLines(after);
  const i = lines.findIndex((l) => LINE_39.test(l));
  return i >= 0 && lines.slice(i + 1).some((l) => LINE_40.test(l));
}
