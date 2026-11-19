// ブラウザ版（PWA）が最初に開く町の決め方。
// ブラウザ版の「自分の町」は Worker が中継する ccn の入口（ccn.fybe.jp）のノードで、手元の Mac とは限らない。
// そのため最初の町は、生きている子が最も多い町にする。同数なら前回選んだ町、それも無ければ入口のノード。
export const LAST_TOWN_KEY = "claude-town.web-town";

export type TownCount = { name: string; self: boolean; n: number };

export function pickTown(towns: TownCount[], last: string | null): TownCount | null {
  if (!towns.length) return null;
  const max = Math.max(...towns.map((t) => t.n));
  const top = towns.filter((t) => t.n === max);
  return top.find((t) => t.name === last) ?? top.find((t) => t.self) ?? top[0];
}

export function savedTown(): string | null {
  try { return localStorage.getItem(LAST_TOWN_KEY); } catch { return null; }
}
export function saveTown(name: string) {
  try { localStorage.setItem(LAST_TOWN_KEY, name); } catch { /* 保存できなくても動きは変えない */ }
}
