// 会話の欄の差分（#10）。Rust の conversation は、画面が持っている数（since）を受け取り、増えた分だけを返す。
// 各項目には通し番号 n が付き、吹き出しの key に使う
import type { ConvItem } from "./model";

/** 画面に持つ件数。Rust の KEEP_MESSAGES と同じ */
export const KEEP_CONV = 80;

/** 今の動き（#59）。時刻は ISO の文字列か ms の数 */
export type LiveTool = { id: string; kind: string; text: string; at: string | number | null };
export type Live = {
  /** 結果がまだ無い道具（古い順） */
  tools: LiveTool[];
  /** 最後の出来事の種類と時刻 */
  last: "user" | "thinking" | "text" | "tool" | "result" | null;
  last_at: string | number | null;
  /** 最後に文が届いた時刻（ターンの始まり） */
  turn_at: string | number | null;
};

/** reset=true なら持っている分を捨てて items に置き換える。total は次の since に渡す。live は毎回全部が来る */
export type ConvDelta = { items: ConvItem[]; total: number; reset: boolean; live?: Live | null };

/** 末尾の1行に出す中身。label は今の動き、heads は複数の道具を実行中のときの中身の頭、since は経過を数え始める時刻 */
export type LiveSummary = { label: string; heads: string[]; since: number | null };

export function msOf(at: string | number | null | undefined): number | null {
  if (at == null || at === "") return null;
  const t = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/**
 * 今の動きを1行に縮める。結果の無い道具が1つならその中身、複数なら種類ごとの件数（シェル2件・ccn 2件を実行中）と、新しい順に3件の頭。
 * 道具が無ければ「考え中」とし、最後の出来事から数える（thinking は書き終わってから jsonl に出るので、考えている間は前の出来事が最後になる）
 */
export function liveSummary(live: Live): LiveSummary {
  const t = live.tools;
  if (t.length === 1) return { label: t[0].text, heads: [], since: msOf(t[0].at) };
  if (t.length > 1) {
    const counts = new Map<string, number>();
    for (const x of t) counts.set(x.kind, (counts.get(x.kind) ?? 0) + 1);
    const label = [...counts].map(([k, n]) => `${k}${/^[\x00-\x7f]+$/.test(k) ? " " : ""}${n}件`).join("・") + "を実行中";
    return { label, heads: t.slice(-3).reverse().map((x) => x.text), since: msOf(t[0].at) };
  }
  // 作業中に変わった直後は、前のターンの末尾が最後の出来事のことがある。ターンの始まりより前からは数えない
  const last = msOf(live.last_at), turn = msOf(live.turn_at);
  return { label: "考え中", heads: [], since: last != null && turn != null ? Math.max(last, turn) : last };
}

/** 経過の書き方。59秒まで「12秒」、それより後は「1分5秒」、1時間より後は「1時間2分」 */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
}

/** live が中身として同じか。同じなら前の物を使い、末尾の行を描き直さない */
export function sameLive(a: Live | null | undefined, b: Live | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

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

/** 送ったばかりの文の仮の項目。after は送り始めたときに持っていた最後の番号で、これより後に届いた発言とだけ比べる */
export type PendingItem = ConvItem & { after: number };

/**
 * 画像のファイルのパス。文の頭か空白の直後で、/ か ~ から始まるもの（空白は \ 付きか、引用符で囲んだもの）。
 * CLI は読める画像のパスを [Image #3] の添付に置き換える
 */
const IMAGE_PATH = /(^|\s)(?:'[/~][^'\n]*\.(?:png|jpe?g|gif|webp)'|"[/~][^"\n]*\.(?:png|jpe?g|gif|webp)"|[/~](?:\\ |[^\s'"])*\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;
/**
 * 比べる形にそろえる。空白の並びを1つにし（端末に貼ると改行や行末の空白が変わる）、画像のパスと [Image #3] の印を除く
 * （送った文のパスが、会話ではパスのままのことも印になることもある、#69）
 */
const canon = (s: string) => s.replace(/\[Image #\d+\]/g, " ").replace(IMAGE_PATH, "$1 ").replace(/\s+/g, " ").trim();
const sameText = (a: string, b: string) => canon(a) === canon(b);

/**
 * 会話に出た仮の項目を消す（#69）。送った順に1件ずつ、まだ使っていない user の発言と突き合わせる（同じ「はい」を2回送っても1件ずつ消す）。
 * 後に送った文が会話に出たら、それより前に送った仮の項目も消す。CLI は届いた順に文を取り込むので、前の文も取り込まれている。
 * 前の文の形が会話で変わっていて（[Image #1] など）突き合わせられなくても、仮の項目が後の発言より下に残らない。
 * 変わらなければ pending をそのまま返す
 */
export function settlePending(items: ConvItem[], pending: PendingItem[]): PendingItem[] {
  if (!pending.length) return pending;
  const used = new Set<number>();
  let last = -1;
  pending.forEach((x, i) => {
    const hit = items.findIndex((y, j) => !used.has(j) && (y.n ?? -1) > x.after && y.role === "user" && sameText(y.text, x.text));
    if (hit >= 0) { used.add(hit); last = i; }
  });
  return last < 0 ? pending : pending.slice(last + 1);
}
