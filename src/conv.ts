// 会話の欄の差分（#10）。Rust の conversation は、画面が持っている数（since）を受け取り、増えた分だけを返す。
// 各項目には通し番号 n が付き、吹き出しの key に使う
import type { ConvItem } from "./model";

/** 画面に持つ件数。Rust の KEEP_MESSAGES と同じ */
export const KEEP_CONV = 80;

/** reset=true なら持っている分を捨てて items に置き換える。total は次の since に渡す */
export type ConvDelta = { items: ConvItem[]; total: number; reset: boolean };

/** 保存してある会話（Rust の conversation_cache、src-tauri/src/offline.rs）。ネットが切れても出せるよう、開いたセッションの分を持つ */
export type ConvCache = { savedAt: number; total: number; items: ConvItem[] };

/** 時刻を「11/13 09:05」の形にする（保存した時刻の表示） */
export function savedLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 差分を足した一覧。増えていなければ prev をそのまま返す（描き直さない） */
export function mergeConv(prev: ConvItem[], d: ConvDelta, keep = KEEP_CONV): ConvItem[] {
  if (d.reset) return d.items.length > keep ? d.items.slice(-keep) : d.items;
  // 取得が重なって同じ差分が2回届いても、持っている番号より後だけを足す
  const last = prev[prev.length - 1]?.n ?? -1;
  const add = d.items.filter((x) => (x.n ?? Infinity) > last);
  if (!add.length) return prev;
  const next = prev.concat(add);
  return next.length > keep ? next.slice(-keep) : next;
}

/** 全部の一覧から、Rust と同じ形の差分を作る（ブラウザ表示の仮の会話とモック用） */
export function deltaOf(all: ConvItem[], since: number | null | undefined): ConvDelta {
  const items = all.map((x, n) => ({ ...x, n }));
  if (since == null || since > all.length) return { items: items.slice(-KEEP_CONV), total: all.length, reset: true };
  return { items: items.slice(since), total: all.length, reset: false };
}
