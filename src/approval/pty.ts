// アプリが立てたセッション（PTY）の承認の欄（#83）。Rust の dialog.rs が端末の承認の画面から読んだ行（options）を、ボタンの文にする。
// 押すと、行の番号と元の文を Rust に返し、Rust は画面の同じ番号の行が同じ文のときだけ押す。
import type { Pick, Question } from "./answers";

export type ScreenRow = { n: number; label: string };

/** 画面の行がボタンになるか（断る行と、計画を続けさせる行は別のボタンにする） */
export const isDenyRow = (label: string) => label === "No" || label.startsWith("No,");
export const isReviseRow = (label: string) => label.startsWith("Tell Claude what to change");

/** 道具の承認の行の文。分からない行は元の英語のまま出す（title にはいつも元の文を出す） */
export function toolLabel(label: string): string {
  if (label === "Yes") return "許可する";
  if (/^Yes, and (don't ask again|always allow)/.test(label)) return "許可して、以後は聞かない";
  if (label.startsWith("Yes, and switch to accept edits") || label.startsWith("Yes, allow all edits")) return "許可して、編集は聞かない";
  if (label.startsWith("Yes, and switch to auto mode")) return "許可して、auto モードにする";
  return label;
}

/** 計画の確認の行の文 */
export function planLabel(label: string): string {
  if (label.startsWith("Yes, and use auto mode")) return "承認する（auto モード）";
  if (label.startsWith("Yes, manually approve edits")) return "承認する（編集は毎回聞く）";
  if (/^Yes,( and)? auto-accept edits/.test(label)) return "承認する（編集は聞かない）";
  if (label.startsWith("Yes, and bypass permissions")) return "承認する（何も聞かない）";
  return label;
}

/** 質問の答えを、Rust に渡す形（選んだ選択肢の番号と「その他」の文）にする。番号は選択肢の順に並べる（CLI の答えも選択肢の順になる） */
export function ptyPicks(questions: Question[], picks: Pick[]): { picked: number[]; other: string }[] {
  return questions.map((q, i) => {
    const p = picks[i] ?? { picked: [], other: "" };
    const labels = (q.options ?? []).map((o) => o.label);
    const other = p.other.trim();
    // 単一選択で「その他」を書いたときは、選んだ選択肢を送らない（answerText と同じく「その他」を優先する）
    const picked = q.multiSelect || !other ? labels.flatMap((l, j) => (p.picked.includes(l) ? [j] : [])) : [];
    return { picked, other };
  });
}
