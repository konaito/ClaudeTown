// メッセージの中の URL を見つけて、既定のブラウザで開く。
// 検出を自作にした理由: linkify-it 6.1.0 と linkifyjs 4.4.0 は、URL の直後に続く日本語（「…/pull/35を見て」）まで URL に含める。
// この町の文は和文と URL の間に空白を入れないので、URL に使える ASCII の文字だけを URL として取る。
// そのため、日本語をそのまま含む URL（https://ja.wikipedia.org/wiki/東京 など）は日本語の手前で切れる。
import { openUrl } from "@tauri-apps/plugin-opener";

/** URL に使える ASCII の文字（RFC 3986 の unreserved、reserved と % ） */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
/**
 * ターミナル用（@xterm/addon-web-links の urlRegex）。アドオンは一致した文字列をそのまま使うので、
 * 末尾に来られない文字（文の終わりの記号と閉じ括弧）を正規表現の側で除く
 */
export const TERM_URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*[A-Za-z0-9\-_~/#@$&+=%]/;
/** 文の終わりの記号。URL の末尾にあれば URL から外す */
const TRAIL = /[.,:;!?'"*]$/;

function trimEnd(u: string): string {
  for (;;) {
    if (TRAIL.test(u)) { u = u.slice(0, -1); continue; }
    // 閉じ括弧は、URL の中に対になる開き括弧が無いときだけ外す（https://en.wikipedia.org/wiki/Foo_(bar) は残す）
    const last = u[u.length - 1];
    const open = last === ")" ? "(" : last === "]" ? "[" : null;
    if (open && count(u, open) < count(u, last)) { u = u.slice(0, -1); continue; }
    return u;
  }
}

function count(s: string, c: string): number {
  let n = 0;
  for (const x of s) if (x === c) n++;
  return n;
}

export type Piece = { text: string; url?: string };

/** 文を、ただの文字と URL に分ける。URL の断片には開く先（url）が付く */
export function splitLinks(s: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const u = trimEnd(m[0]);
    const url = safeUrl(u);
    if (!url) continue;
    const at = m.index!;
    if (at > last) out.push({ text: s.slice(last, at) });
    out.push({ text: u, url });
    last = at + u.length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

/** http と https の URL なら正規化した文字列を返す。それ以外（javascript:、file:、mailto: など）は null */
export function safeUrl(u: string): string | null {
  try {
    const p = new URL(u.trim());
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
  } catch { return null; }
}

/** 既定のブラウザで開く。http と https 以外は開かない。開けたら true */
export function openExternal(u: string): boolean {
  const url = safeUrl(u);
  if (!url) return false;
  openUrl(url).catch((e) => console.error("URL を開けなかった", url, e));
  return true;
}
