// 止めるボタン（interrupt_session）の返事の読み方（#240 の 2）。
// アプリの Rust は、端末への書き込みが3秒以上戻っていないと Esc を書かずに { stuck: true, stuckMs } を返す。
// ブラウザ版（ノードの /interrupt）や古い版の返事（undefined など）は、詰まっていないと読む。

/** 詰まっていれば、書き込みが戻っていない時間（ms）。詰まっていなければ null */
export function stuckMs(r: unknown): number | null {
  if (!r || typeof r !== "object" || (r as { stuck?: unknown }).stuck !== true) return null;
  const ms = (r as { stuckMs?: unknown }).stuckMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/** 確かめの画面の本文 */
export function stuckText(ms: number): string {
  return `端末への書き込みが${Math.max(1, Math.round(ms / 1000))}秒戻っていない。止める（Esc）も届かない。claude を止めて、同じ会話を --resume で立て直す？ 届いていない入力は捨てる。`;
}
