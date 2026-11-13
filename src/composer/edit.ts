// 入力欄の文の編集（readline のキー）と、補完の語の見つけ方。DOM に触らない関数だけを置き、テストする。
// 動きの出所は docs/research/cli-input.md（Claude Code の interactive-mode の Text editing）。

/** 文と、選んでいる範囲。start == end なら位置 */
export type Sel = { text: string; start: number; end: number };
/** 置き換える範囲と、入れる文。カーソルは入れた文の後ろに置く。killed は Ctrl+Y で貼れるように取っておく文 */
export type Edit = { from: number; to: number; insert: string; caret?: number; killed?: string };

const lineStart = (t: string, i: number) => t.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (t: string, i: number) => { const n = t.indexOf("\n", i); return n < 0 ? t.length : n; };

/** Ctrl+A: 今の行（改行で区切った行）の先頭へ */
export const toLineStart = (s: Sel) => lineStart(s.text, s.start);
/** Ctrl+E: 今の行の末尾へ */
export const toLineEnd = (s: Sel) => lineEnd(s.text, s.end);

/** Ctrl+K: カーソルから行末までを消す。行末にいるときは改行を消す（readline と同じ） */
export function killToEnd(s: Sel): Edit | null {
  const e = lineEnd(s.text, s.start);
  const to = e === s.start ? Math.min(s.text.length, e + 1) : e;
  if (to === s.start) return null;
  return { from: s.start, to, insert: "", killed: s.text.slice(s.start, to) };
}

/** Ctrl+U: 行頭からカーソルまでを消す。行頭にいるときは前の改行を消すので、続けて押すと前の行も消える（CLI の「Repeat to clear across lines」） */
export function killToStart(s: Sel): Edit | null {
  const b = lineStart(s.text, s.start);
  const from = b === s.start ? Math.max(0, b - 1) : b;
  if (from === s.start) return null;
  return { from, to: s.start, insert: "", killed: s.text.slice(from, s.start) };
}

/** Ctrl+W: カーソルの前の空白まで消す。句読点では止まらないので、パスや --flag=value は1回で消える */
export function killWordBack(s: Sel): Edit | null {
  let i = s.start;
  while (i > 0 && /\s/.test(s.text[i - 1])) i--;
  while (i > 0 && !/\s/.test(s.text[i - 1])) i--;
  if (i === s.start) return null;
  return { from: i, to: s.start, insert: "", killed: s.text.slice(i, s.start) };
}

// 語の切れ目。CLI は「文字と数字の並び」を1語とし、_ . / で区切る。日本語のように空白の無い文でも1語ずつ動く。
// 日本語の語の切れ目は Intl.Segmenter に任せ、その中をさらに文字と数字以外で区切る
// tsconfig の lib が ES2020 なので、Intl.Segmenter の型はここで書く（WebKit と bun には実物がある）
type Segmenter = { segment(t: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };
const SegmenterCtor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: "word" }) => Segmenter }).Segmenter;
const segmenter = SegmenterCtor ? new SegmenterCtor("ja", { granularity: "word" }) : null;
const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** 語の [始まり, 終わり) の並び */
export function words(t: string): [number, number][] {
  const out: [number, number][] = [];
  const pushRuns = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      while (i < to && !isWordChar(t[i])) i++;
      const b = i;
      while (i < to && isWordChar(t[i])) i++;
      if (i > b) out.push([b, i]);
    }
  };
  if (!segmenter) { pushRuns(0, t.length); return out; }
  for (const seg of segmenter.segment(t)) {
    if (seg.isWordLike) pushRuns(seg.index, seg.index + seg.segment.length);
  }
  return out;
}

/** Alt+B: 前の語の頭へ */
export function wordBack(s: Sel): number {
  const w = words(s.text).filter(([b]) => b < s.start);
  return w.length ? w[w.length - 1][0] : 0;
}
/** Alt+F: 今の語の終わりへ。語の間にいるときは次の語の終わりへ */
export function wordForward(s: Sel): number {
  const w = words(s.text).find(([, e]) => e > s.end);
  return w ? w[1] : s.text.length;
}
/** Alt+D: 今の語の終わり（語の間なら次の語の終わり）まで消す */
export function killWordForward(s: Sel): Edit | null {
  const to = wordForward(s);
  if (to === s.start) return null;
  return { from: s.start, to, insert: "", killed: s.text.slice(s.start, to) };
}

/**
 * Enter で送るか、改行にするか。CLI では、カーソルの前が \ のときの Enter は、\ を消して改行にする（「\ + Enter」）。
 * 返り値が Edit なら改行にする。null なら送る
 */
export function backslashNewline(s: Sel): Edit | null {
  if (s.start !== s.end || s.start === 0 || s.text[s.start - 1] !== "\\") return null;
  return { from: s.start - 1, to: s.start, insert: "\n" };
}

/** 補完の種類と、置き換える範囲。/ は文の頭か空白の後、@ はどこでも空白の後 */
export type Token = { kind: "slash" | "file"; query: string; from: number; to: number; atStart: boolean };

export function tokenAt(s: Sel): Token | null {
  if (s.start !== s.end) return null;
  const before = s.text.slice(0, s.start);
  const m = /(^|\s)([/@])([^\s]*)$/.exec(before);
  if (!m) return null;
  const from = before.length - m[3].length - 1;
  // カーソルの後ろが語の続きなら、そこまでを置き換える
  let to = s.start;
  while (to < s.text.length && !/\s/.test(s.text[to])) to++;
  const kind = m[2] === "/" ? "slash" : "file";
  // ! のシェルモードでは / はパスなので、コマンドの補完を出さない
  if (kind === "slash" && s.text.startsWith("!")) return null;
  return { kind, query: m[3], from, to, atStart: from === 0 };
}

/** / の候補を並べる。名前の頭が合うもの、名前に含むもの、説明に含むものの順 */
export function rankCommands<T extends { name: string; description: string; aliases?: string[] }>(list: T[], q: string, limit = 50): T[] {
  const lq = q.toLowerCase();
  const score = (c: T) => {
    const n = c.name.toLowerCase();
    if (!lq) return 0;
    if (n.startsWith(lq)) return 1;
    if (c.aliases?.some((a) => a.startsWith(lq))) return 2;
    if (n.split(/[:\-_]/).some((p) => p.startsWith(lq))) return 3;
    if (n.includes(lq)) return 4;
    return -1;
  };
  return list
    .map((c, i) => ({ c, s: score(c), i }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.length - b.c.name.length || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * 上下キーの履歴。list は新しい順（0 が一番新しい）。index -1 は打ちかけの文（draft）。
 * 打ちかけの文は、履歴を辿り始めたときに取っておき、下へ戻り切ったときに戻す
 */
export type HistState = { index: number; draft: string };
export function histUp(st: HistState, list: string[], current: string): { st: HistState; text: string } | null {
  if (st.index + 1 >= list.length) return null;
  const draft = st.index === -1 ? current : st.draft;
  const index = st.index + 1;
  return { st: { index, draft }, text: list[index] };
}
export function histDown(st: HistState, list: string[]): { st: HistState; text: string } | null {
  if (st.index < 0) return null;
  const index = st.index - 1;
  return { st: { index, draft: st.draft }, text: index === -1 ? st.draft : list[index] };
}

/** Ctrl+R の検索。from 番目より古いものから、query を含む最初のものを探す */
export function searchHistory(list: string[], query: string, from = 0): number {
  if (!query) return -1;
  const q = query.toLowerCase();
  for (let i = Math.max(0, from); i < list.length; i++) if (list[i].toLowerCase().includes(q)) return i;
  return -1;
}

/** 新しい順の並びの先頭に足す。同じ文は前のものを消す */
export function pushHistory(list: string[], text: string): string[] {
  const t = text.trim();
  if (!t) return list;
  return [text, ...list.filter((x) => x !== text)];
}

/** 2つの並びを、新しい順を保ったまま重ねる（手元で送った分を先に） */
export function mergeHistory(local: string[], fetched: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...local, ...fetched]) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}
