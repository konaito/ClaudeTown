// AskUserQuestion の答えの組み立て（#83）。答えは質問ごとに1つの文字列で、複数選択は label を「, 」でつなぐ。
// 2026-11-21 に PTY の子で、tool_result が `"使う色は？"="赤, 緑"` になるのを確かめた。

export type Question = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };
/** 選んだ選択肢と、「その他」に書いた文 */
export type Pick = { picked: string[]; other: string };

export const emptyPick = (): Pick => ({ picked: [], other: "" });

/** 1つの質問の答え。単一選択は「その他」に書いた文を優先する。複数選択は選んだ順に並べ、「その他」を最後に足す。空なら "" */
export function answerText(q: Question, p: Pick): string {
  const other = p.other.trim();
  if (!q.multiSelect) return other || p.picked[0] || "";
  return [...p.picked, ...(other ? [other] : [])].join(", ");
}
