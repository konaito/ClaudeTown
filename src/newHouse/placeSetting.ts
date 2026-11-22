// 「新しい世帯」を押したときに親を立てる場所の設定（#92）。
// 場所は、この画面（この Mac のアプリ、ブラウザ版ではそのブラウザ）に1つだけ持つ。
// 保存先は localStorage（ペインの幅 claude-town.split3 と開発版のスキンと同じ。Tauri の WebView でもブラウザ版でも使える）。
// null は「設定していない」で、そのとき create_session は cwd を渡さず、Rust の既定（~/Documents/meta）で立つ。

export const PLACE_KEY = "claude-town.newHousePlace";
/** 設定していないときに立つ場所（src-tauri/src/lib.rs の create_session の既定） */
export const DEFAULT_PLACE_LABEL = "~/Documents/meta";

export function loadPlace(): string | null {
  try {
    const v = localStorage.getItem(PLACE_KEY);
    return v && v.startsWith("/") ? v : null;
  } catch { return null; }
}

/** null は設定を消す（既定に戻す）。保存できなくても、今の画面の動きは state で変える */
export function savePlace(path: string | null) {
  try { if (path) localStorage.setItem(PLACE_KEY, path); else localStorage.removeItem(PLACE_KEY); } catch { /* 保存できなくても動きは変えない */ }
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

export type PlaceCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * 入力した場所の確認（画面でわかる範囲）。存在とディレクトリかどうかは Rust（pty.rs の spawn）が調べるので、立てたときの失敗で伝える。
 * roots と lobby はブラウザ版（PWA）の ccn の分で、ccn は cwd が roots の外だと 400 で断る。アプリでは roots が空なので、範囲で断らない
 */
export function checkPlace(input: string, roots: string[], lobby: string | null): PlaceCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "場所を入力する" };
  if (!raw.startsWith("/")) return { ok: false, reason: "絶対パス（/ から始まるもの）で入力する" };
  const path = trim(raw);
  const rs = roots.map(trim);
  if (rs.length && !rs.some((r) => under(path, r))) return { ok: false, reason: `ccn が立てられる範囲の外（${rs.join("、")} の中だけ）` };
  if (lobby && under(path, trim(lobby))) return { ok: false, reason: "受け口の場所は、新しい世帯の行き先にしない" };
  return { ok: true, path };
}

/** 新しい世帯を立てられなかったときの通知。設定した場所で立てていたなら、その場所と、設定から変えられることを足す */
export function placeFailure(place: string | null, e: unknown): string {
  const base = `世帯を作れなかった: ${e}`;
  return place ? `${base}（場所: ${place.replace(/^\/Users\/[^/]+/, "~")}。設定で変えられる）` : base;
}
