// 世帯モジュールの並べ方の検証。docs/design/household-packing.md の検証条件5つ。
// 実行: bun test src/layout
import { describe, expect, test } from "bun:test";
import { packHouseholds, readingOrder, type Box, type Packed } from "./pack";

const GAP = 28;
const ids = (bs: Box[]) => bs.map((b) => b.id);
const overlaps = (ps: Packed[]) => {
  let n = 0;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], b = ps[j];
    if (a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP) n++;
  }
  return n;
};
const report: Record<string, unknown>[] = [];

// 幅と高さの違う8世帯（入力順は親の開始時刻の順を想定）
const mixed: Box[] = [
  { id: "A", w: 520, h: 600 }, { id: "B", w: 300, h: 220 }, { id: "C", w: 300, h: 160 }, { id: "D", w: 640, h: 300 },
  { id: "E", w: 260, h: 140 }, { id: "F", w: 420, h: 380 }, { id: "G", w: 240, h: 120 }, { id: "H", w: 300, h: 260 },
];

describe("世帯モジュールの並べ方", () => {
  test("1. 高さや幅が違う世帯を混ぜても、画面の読み順が入力順と一致し、重ならない", () => {
    for (const W of [900, 1200, 1600]) {
      const r = packHouseholds(mixed, W, GAP);
      report.push({ ケース: 1, 幅: W, 読み順: readingOrder(r.items).join(""), 重なり: overlaps(r.items), 高さ: r.height, 座標: r.items.map((p) => `${p.id}(${p.x},${p.y})`).join(" ") });
      expect(readingOrder(r.items)).toEqual(ids(mixed));
      expect(overlaps(r.items)).toBe(0);
      expect(Math.max(...r.items.map((p) => p.x + p.w))).toBeLessThanOrEqual(W);
    }
  });

  test("2. 小さい世帯を後から足しても、上の空きへ入り込んで先の世帯を追い越さない", () => {
    const W = 1200;
    const before = packHouseholds(mixed, W, GAP);
    const added = packHouseholds([...mixed, { id: "Z", w: 120, h: 80 }], W, GAP);
    const z = added.items.find((p) => p.id === "Z")!;
    const last = added.items.find((p) => p.id === "H")!;
    const same = before.items.every((p) => { const q = added.items.find((x) => x.id === p.id)!; return q.x === p.x && q.y === p.y; });
    report.push({ ケース: 2, 足したZ: `(${z.x},${z.y})`, 直前H: `(${last.x},${last.y})`, 先の世帯は動かない: same, 読み順: readingOrder(added.items).join("") });
    expect(z.y).toBeGreaterThanOrEqual(last.y);
    expect(readingOrder(added.items)).toEqual([...ids(mixed), "Z"]);
    expect(same).toBe(true);
  });

  test("3. 大きさの変更・削除・画面幅の変更の後も、残った世帯の順序を保つ", () => {
    const W = 1200;
    const resized = mixed.map((b) => (b.id === "B" ? { ...b, h: 520 } : b.id === "E" ? { ...b, w: 700 } : b));
    const removed = mixed.filter((b) => b.id !== "C" && b.id !== "F");
    const cases = { 大きさの変更: packHouseholds(resized, W, GAP), 削除: packHouseholds(removed, W, GAP), 幅900: packHouseholds(mixed, 900, GAP), 幅2000: packHouseholds(mixed, 2000, GAP) };
    for (const [k, r] of Object.entries(cases)) {
      const want = k === "削除" ? ids(removed) : ids(mixed);
      report.push({ ケース: 3, 変更: k, 読み順: readingOrder(r.items).join(""), 重なり: overlaps(r.items) });
      expect(readingOrder(r.items)).toEqual(want);
      expect(overlaps(r.items)).toBe(0);
    }
  });

  test("4. 同じ入力順・大きさ・横幅からは、常に同じ座標", () => {
    const a = packHouseholds(mixed, 1200, GAP), b = packHouseholds(mixed, 1200, GAP);
    report.push({ ケース: 4, 一致: JSON.stringify(a) === JSON.stringify(b) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("5. 順序を守るための空白はそのまま残る（後の小さい世帯で埋めない）", () => {
    // 高い A の右に B が入り、C は B の下に入れるが、その下の空きに来た小さい D は C より上には行かない
    const W = 1000;
    const bs: Box[] = [{ id: "A", w: 500, h: 600 }, { id: "B", w: 400, h: 100 }, { id: "C", w: 900, h: 100 }, { id: "D", w: 200, h: 80 }];
    const r = packHouseholds(bs, W, GAP);
    const get = (id: string) => r.items.find((p) => p.id === id)!;
    // C は A の右に入らない（幅が足りない）ので A の下へ。D は B の下に空きがあっても、C より上には置かない
    const gapUnderB = get("C").y - (get("B").y + get("B").h);
    report.push({ ケース: 5, 座標: r.items.map((p) => `${p.id}(${p.x},${p.y})`).join(" "), "Bの下に残る空白": gapUnderB, 読み順: readingOrder(r.items).join("") });
    expect(get("C").y).toBeGreaterThan(get("A").y + get("A").h);
    expect(get("D").y).toBeGreaterThanOrEqual(get("C").y);
    expect(gapUnderB).toBeGreaterThan(GAP);
    expect(readingOrder(r.items)).toEqual(ids(bs));
  });

  test("結果の表", () => { for (const r of report) console.log(JSON.stringify(r)); });
});
