// 世帯モジュールの並べ方（docs/design/household-packing.md）。世帯の中のキャラの配置（layout.ts）とは別の処理。
// 入力順に1個ずつ置く。候補位置は「左端」「置いた箱の右端＋余白」と「上端」「置いた箱の下端＋余白」「直前の箱の上端」の組み合わせ。
// 有効な候補（横幅に収まる、余白込みで重ならない、直前より上に置かない、直前と同じ高さなら右側）のうち、最も上、同じ高さなら最も左を選ぶ。
// 隙間は残してよく、後の世帯が先の世帯を追い越さない。毎回最初から計算する（前の座標は障害物にしない）。乱数と時刻は使わない。

export type Box = { id: string; w: number; h: number };
export type Packed = Box & { x: number; y: number };

export function packHouseholds(boxes: Box[], containerW: number, gap: number): { items: Packed[]; width: number; height: number } {
  const placed: Packed[] = [];
  for (const b of boxes) {
    const prev = placed[placed.length - 1];
    const xs = new Set<number>([0]);
    const ys = new Set<number>([0]);
    for (const p of placed) {
      xs.add(p.x + p.w + gap);
      ys.add(p.y + p.h + gap);
      ys.add(p.y);
    }
    let best: { x: number; y: number } | null = null;
    for (const y of ys) {
      if (prev && y < prev.y) continue; // 直前より上に置かない
      for (const x of xs) {
        // 横幅に収まる。箱がコンテナより広いときは、左端だけを許す
        if (x + b.w > containerW && !(x === 0 && b.w > containerW)) continue;
        // 直前と同じ高さに置くなら、その右側
        if (prev && y === prev.y && x < prev.x + prev.w + gap) continue;
        // 余白込みで重ならない
        if (placed.some((p) => x < p.x + p.w + gap && p.x < x + b.w + gap && y < p.y + p.h + gap && p.y < y + b.h + gap)) continue;
        if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
      }
    }
    // 候補が1つも無いことは無い（左端で、配置済みの一番下の下は必ず空いている）が、念のため一番下に置く
    if (!best) best = { x: 0, y: Math.max(0, ...placed.map((p) => p.y + p.h + gap)) };
    placed.push({ ...b, ...best });
  }
  const width = Math.max(0, ...placed.map((p) => p.x + p.w));
  const height = Math.max(0, ...placed.map((p) => p.y + p.h));
  return { items: placed, width, height };
}

/** 画面の読み順（上から下、同じ高さなら左から右） */
export function readingOrder(items: Packed[]): string[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.id);
}
