// 新しい世帯のペイン（#89）に出す「最近使った場所」の一覧を、手元のノードの ccn の3つの応答から作る。
// 合わせ方は ccn の MCP の list_places と同じで、ccn には手を入れない:
// - GET /api/places の候補（lastUsedAt は、その場所かその下で動いたセッションの最後の活動）
// - GET /api/sessions の cwd と lastActivityAt（止まったセッションも含む）
// - GET /api/host の roots と lobby（ccn が立てられるのは roots の内側だけ。受け口は新しい世帯の行き先にしない）
// セッションの cwd が places の候補の下（worktree や下のフォルダ）にあれば、その候補にまとめる。
// どの候補の下でもない cwd（~/Documents の直下など）は、その cwd のまま出す

export type PlacesInput = {
  roots: string[];
  lobby: string | null;
  sessions: { cwd?: string | null; lastActivityAt?: number | null }[];
  /** 古い ccn には /api/places が無い（404）。そのときは null */
  places: { path: string; lastUsedAt?: number | null }[] | null;
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
