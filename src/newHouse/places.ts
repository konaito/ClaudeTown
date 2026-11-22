// 新しい世帯のペイン（#89）に出す「最近使った場所」の一覧を作る。材料は Rust の house_places（アプリ）か、ccn の3つの応答（ブラウザ版）:
// - places: 場所の候補と最後に使った時刻。アプリは Claude Code の入力の履歴（src-tauri/src/places.rs）、ブラウザ版は ccn の GET /api/places
// - sessions: いま動いているセッションの cwd と lastActivityAt
// - roots と lobby: ブラウザ版だけ。ccn が立てられるのは roots の内側だけで、受け口は新しい世帯の行き先にしない。アプリでは空
// セッションの cwd が places の候補の下（worktree や下のフォルダ）にあれば、その候補にまとめる。
// どの候補の下でもない cwd（~/Documents の直下など）は、その cwd のまま出す

export type PlacesInput = {
  roots: string[];
  lobby: string | null;
  sessions: { cwd?: string | null; lastActivityAt?: number | null }[];
  /** 古い ccn には /api/places が無い（404）。そのときは null */
  places: { path: string; lastUsedAt?: number | null }[] | null;
  /** 場所を設定していないときに新しい世帯を立てる場所（絶対パス）。アプリの Rust だけが返す */
  defaultPlace?: string | null;
};
export type RecentPlace = { path: string; at: number };

/** ペインに出す件数（本人の見本が20件） */
export const RECENT_PLACES_MAX = 20;

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

export function recentPlaces(input: PlacesInput, limit = RECENT_PLACES_MAX): RecentPlace[] {
  const roots = input.roots.map(trim);
  const lobby = input.lobby ? trim(input.lobby) : null;
  const ok = (p: string) => (!roots.length || roots.some((r) => under(p, r))) && !(lobby && under(p, lobby));
  // 深い候補を先に当てる（family-computing と family-computing/xxx の両方が候補なら、下のほうにまとめる）
  const placePaths = (input.places ?? []).map((p) => trim(p.path)).sort((a, b) => b.length - a.length);
  const at = new Map<string, number>();
  const bump = (p: string, t: number) => { if (ok(p)) at.set(p, Math.max(at.get(p) ?? 0, t)); };
  for (const p of input.places ?? []) if (p.lastUsedAt) bump(trim(p.path), p.lastUsedAt);
  for (const s of input.sessions) {
    if (!s.cwd || !s.lastActivityAt) continue;
    const cwd = trim(s.cwd);
    bump(placePaths.find((p) => under(cwd, p)) ?? cwd, s.lastActivityAt);
  }
  return [...at].map(([path, t]) => ({ path, at: t }))
    .sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/**
 * 新しい世帯の置き場所（設定した場所、無ければ既定の場所）を一覧から除く（2026-11-21 本人の決定）。
 * 「＋ 新しい世帯」のボタンがその場所で立てるので、一覧に同じ場所を並べない。設定を変えたら、変えた先を除く。どちらも無ければ除かない
 */
export function withoutPlace(list: RecentPlace[], place: string | null, defaultPlace: string | null | undefined): RecentPlace[] {
  const target = place ?? defaultPlace ?? null;
  if (!target) return list;
  const t = trim(target);
  return list.filter((p) => trim(p.path) !== t);
}

/** 一覧の日時。本人の見本と同じ「11-21 14:40」の形（手元の時刻） */
export function placeTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一覧のパス。ホームを ~ にする（ほかの画面の場所の出し方と同じ） */
export function placeLabel(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** 一覧の主の名前。パスの最後のディレクトリ名。ホームは ~、ルートは / */
export function placeName(path: string): string {
  const p = placeLabel(trim(path));
  if (p === "~" || p === "/") return p;
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

/** 場所ごとのリポジトリ名（owner/repo）。Rust の place_repos の出力。連携していない場所は含まれない */
export type PlaceRepos = Record<string, string>;
