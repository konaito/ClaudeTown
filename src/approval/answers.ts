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

/**
 * 承認の欄で補いに使う計画の本文。会話で最後の ExitPlanMode の道具の行の plan で、まだ答えていない（結果が無い）ときだけ返す。
 * 見直しを頼んだあとの再確認では、新しい道具の行を読むまで前の計画が最後に残っている。前の計画には結果が付くので、それは出さない（#83）
 */
export function openPlan(items: { role: string; id?: string | null; plan?: string; result?: unknown }[]): string | null {
  const answered = new Set(items.filter((x) => x.role === "result" && x.id).map((x) => x.id));
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (x.role === "tool" && x.plan) return x.result || (x.id && answered.has(x.id)) ? null : x.plan;
  }
  return null;
}
