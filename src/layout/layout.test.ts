// 配置計算だけの検証。docs/design/physics-layout.md の 10 の8ケースを数値で確かめる。
// 実行: bun test src/layout
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { childSlots, gridRowGap, layoutFamily, type LNode, type Placed } from "./layout";
import { LAYOUT, boxOf, groupSizeOf } from "./params";

const deg = (r: number) => (r * 180) / Math.PI;
const report: Record<string, unknown>[] = [];

/** 親子の表から入力を作る。[id, 親] の並びで、並び順を生成順にする */
function family(rows: [string, string | null][], names?: Record<string, string>): LNode[] {
  const depth = new Map<string, number>();
  for (const [id, p] of rows) depth.set(id, p ? depth.get(p)! + 1 : 0);
  return rows.map(([id, p], i) => {
    const b = boxOf(depth.get(id)!, names?.[id] ?? id);
    return { id, parent: p, order: i, w: b.w, h: b.h };
  });
}
const ok = (m: { overlaps: number; crossings: number; edgeThroughNode: number; interleave: number }) =>
  m.overlaps === 0 && m.crossings === 0 && m.edgeThroughNode === 0 && m.interleave === 0;
const get = (ns: Placed[], id: string) => ns.find((n) => n.id === id)!;
// 余白を指定すると、子1〜8人の固定の座標を使わず弧の計算になる。子1〜8人の世帯で弧の計算を確かめる試験はこれを渡す。
// 2026-11-21 から、子1〜8人の世帯は孫がいても固定の座標に置く（7人と8人は同じ日の後の変更から）。弧の計算は子9人以上の世帯で使う
const RADIAL = { gap: LAYOUT.gap };

describe("家族の木の配置", () => {
  test("1. 親1人・子1人: 子は親の真下", () => {
    const r = layoutFamily(family([["p", null], ["c", "p"]]));
    const c = get(r.nodes, "c");
    report.push({ ケース: 1, 子の角度: deg(c.angle).toFixed(1), x: c.x.toFixed(1), y: c.y.toFixed(1), ...r.metrics });
    expect(Math.abs(c.x)).toBeLessThan(0.01);
    expect(c.y).toBeGreaterThan(0);
    expect(ok(r.metrics)).toBe(true);
  });

  test("2. 親1人・子2人（同じ大きさの円、余白なし）: 下向きにまとまり、親から見て約60度", () => {
    const r0 = 30;
    const nodes: LNode[] = [
      { id: "p", parent: null, order: 0, w: 2 * r0, h: 2 * r0, circle: true },
      { id: "a", parent: "p", order: 1, w: 2 * r0, h: 2 * r0, circle: true },
      { id: "b", parent: "p", order: 2, w: 2 * r0, h: 2 * r0, circle: true },
    ];
    const r = layoutFamily(nodes, { gap: 0 });
    const a = get(r.nodes, "a"), b = get(r.nodes, "b");
    const between = deg(Math.abs(a.angle - b.angle));
    const dAB = Math.hypot(a.x - b.x, a.y - b.y), dPA = Math.hypot(a.x, a.y);
    report.push({ ケース: 2, a: deg(a.angle).toFixed(1), b: deg(b.angle).toFixed(1), 開き: between.toFixed(1), 親子の距離: dPA.toFixed(1), 兄弟の距離: dAB.toFixed(1), ...r.metrics });
    expect(Math.abs(between - 60)).toBeLessThan(0.5);
    expect(Math.abs(a.angle + b.angle)).toBeLessThan(1e-9); // 下向きを中心に左右対称
    expect(ok(r.metrics)).toBe(true);
  });

  test("3. 子2人が点対称にならない（配置は入力の位置に左右されず、同じ入力で同じ座標）", () => {
    const input = family([["p", null], ["a", "p"], ["b", "p"]]);
    const r1 = layoutFamily(input), r2 = layoutFamily(input);
    const a = get(r1.nodes, "a"), b = get(r1.nodes, "b");
    report.push({ ケース: 3, a: deg(a.angle).toFixed(1), b: deg(b.angle).toFixed(1), 両方とも下側: a.y > 0 && b.y > 0, "2回の座標が一致": JSON.stringify(r1.nodes) === JSON.stringify(r2.nodes), ...r1.metrics });
    expect(a.y).toBeGreaterThan(0);
    expect(b.y).toBeGreaterThan(0);
    expect(Math.abs(deg(a.angle - b.angle))).toBeLessThan(179);
    expect(JSON.stringify(r1.nodes)).toBe(JSON.stringify(r2.nodes));
    // layout/ の中に乱数と時刻を使うコードが無い
    const dir = join(import.meta.dir);
    const srcs = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(/Math\.random|Date\.now|new Date/.test(srcs)).toBe(false);
  });

  test("4. 子が多数（14人）: 半径が広がり、重なりが残らない", () => {
    const rows: [string, string | null][] = [["p", null]];
    for (let i = 0; i < 14; i++) rows.push([`c${i}`, "p"]);
    const few = layoutFamily(family([["p", null], ["c0", "p"]]));
    const r = layoutFamily(family(rows));
    const R1 = Math.hypot(get(r.nodes, "c0").x, get(r.nodes, "c0").y), R1few = Math.hypot(get(few.nodes, "c0").x, get(few.nodes, "c0").y);
    report.push({ ケース: 4, 子1人の半径: R1few.toFixed(0), 子14人の半径: R1.toFixed(0), 候補ごと: JSON.stringify(r.candidates), ...r.metrics });
    expect(R1).toBeGreaterThan(R1few);
    expect(ok(r.metrics)).toBe(true);
  });

  test("5. 一方の子にだけ孫が多い（弧の計算）: その枝に広い角度が割り当たる", () => {
    const rows: [string, string | null][] = [["p", null], ["a", "p"], ["b", "p"], ["c", "p"]];
    for (let i = 0; i < 8; i++) rows.push([`a${i}`, "a"]);
    rows.push(["b0", "b"], ["c0", "c"]);
    const r = layoutFamily(family(rows), RADIAL);
    const span = (pre: string) => {
      const as = r.nodes.filter((n) => n.id.startsWith(pre) && n.depth === 2).map((n) => n.angle);
      return deg(Math.max(...as) - Math.min(...as));
    };
    const gapAB = deg(get(r.nodes, "b").angle - get(r.nodes, "a").angle), gapBC = deg(get(r.nodes, "c").angle - get(r.nodes, "b").angle);
    report.push({ ケース: 5, a枝の孫の広がり: span("a").toFixed(1), "a→bの角度": gapAB.toFixed(1), "b→cの角度": gapBC.toFixed(1), ...r.metrics });
    expect(gapAB).toBeGreaterThan(gapBC * 1.5);
    expect(ok(r.metrics)).toBe(true);
  });

  test("6. 深さ4まで・合計25体: 世代と親子を追える（重なり・交差・線の通り抜け・混ざりが0）。弧の計算と、子2人の固定の座標の両方", () => {
    const rows: [string, string | null][] = [["meta-0a", null], ["tangle-harvest", "meta-0a"]];
    for (let i = 1; i <= 4; i++) {
      rows.push([`miner-${i}`, "tangle-harvest"]);
      for (let j = 1; j <= 4; j++) rows.push([`miner-${i}.${j}`, `miner-${i}`]);
    }
    rows.push(["deep-1", "miner-2.1"], ["deep-2", "miner-2.1"], ["reviewer", "meta-0a"]);
    const r = layoutFamily(family(rows), RADIAL);
    const fixed = layoutFamily(family(rows));
    expect(fixed.arcIndex).toBe(-1);
    expect(ok(fixed.metrics)).toBe(true);
    expect([get(fixed.nodes, "tangle-harvest"), get(fixed.nodes, "reviewer")].map((n) => [n.x, n.y])).toEqual(childSlots(2)!.map((q) => [q.x, q.y]));
    report.push({ ケース: 6, 固定の座標のs: fixed.metrics.s.toFixed(3), 固定の座標の調整: fixed.metrics.adjustments, 体数: rows.length, 最大の深さ: Math.max(...r.nodes.map((n) => n.depth)), 候補: r.arcIndex, 候補ごと: JSON.stringify(r.candidates), ...r.metrics });
    expect(rows.length).toBe(25);
    expect(ok(r.metrics)).toBe(true);
  });

  test("7. 子の追加・削除（弧の計算）: 回転や反転をせず、角度の順が保たれる", () => {
    const base: [string, string | null][] = [["p", null], ["a", "p"], ["b", "p"], ["c", "p"], ["a1", "a"], ["a2", "a"], ["b1", "b"]];
    const r0 = layoutFamily(family(base), RADIAL);
    const added = layoutFamily(family([...base, ["d", "p"]]), RADIAL);
    const removed = layoutFamily(family(base.filter(([id]) => id !== "b1")), RADIAL);
    const order = (ns: Placed[], ids: string[]) => ids.map((id) => get(ns, id).angle).every((v, i, a) => i === 0 || a[i - 1] < v);
    const moved = (ns: Placed[]) => Math.max(...r0.nodes.filter((n) => ns.some((m) => m.id === n.id)).map((n) => { const m = get(ns, n.id); return Math.hypot(m.x - n.x, m.y - n.y); }));
    const flipped = (ns: Placed[]) => r0.nodes.filter((n) => n.depth > 0 && ns.some((m) => m.id === n.id)).some((n) => Math.sign(Math.round(get(ns, n.id).x)) === -Math.sign(Math.round(n.x)) && Math.abs(n.x) > 20);
    report.push({
      ケース: 7, 候補: `${r0.arcIndex}→追加${added.arcIndex}・削除${removed.arcIndex}`,
      追加後の最大移動px: moved(added.nodes).toFixed(1), 追加後の順: order(added.nodes, ["a", "b", "c", "d"]), 追加後に左右反転: flipped(added.nodes),
      削除後の最大移動px: moved(removed.nodes).toFixed(1), 削除後の順: order(removed.nodes, ["a", "b", "c"]), 削除後に左右反転: flipped(removed.nodes),
      ...added.metrics,
    });
    expect(order(added.nodes, ["a", "b", "c", "d"])).toBe(true);
    expect(order(removed.nodes, ["a", "b", "c"])).toBe(true);
    expect(get(added.nodes, "a").x).toBeLessThan(0); // 最初の子は左のまま
    expect(ok(added.metrics) && ok(removed.metrics)).toBe(true);
  });

  test("8. 長い名前: 実際の箱で重なりを見つけて解消する（弧の計算と、子2人の固定の座標の両方）", () => {
    const rows: [string, string | null][] = [["p", null], ["a", "p"], ["b", "p"]];
    const names: Record<string, string> = {};
    for (let i = 0; i < 6; i++) { rows.push([`a${i}`, "a"]); names[`a${i}`] = `long-worker-name-${i}-review`; }
    for (let i = 0; i < 6; i++) { rows.push([`b${i}`, "b"]); names[`b${i}`] = `長い名前の孫その${i}`; }
    const short = layoutFamily(family(rows), RADIAL);
    const long = layoutFamily(family(rows, names), RADIAL);
    const fixedLong = layoutFamily(family(rows, names));
    expect(fixedLong.arcIndex).toBe(-1);
    expect(ok(fixedLong.metrics)).toBe(true);
    const w = (r: typeof long) => Math.max(...r.nodes.filter((n) => n.depth === 2).map((n) => n.w));
    report.push({ ケース: 8, 短い名前の箱の幅: w(short).toFixed(0), 長い名前の箱の幅: w(long).toFixed(0), 調整の回数: long.metrics.adjustments, ...long.metrics });
    expect(w(long)).toBeGreaterThan(w(short));
    expect(ok(long.metrics)).toBe(true);
  });

  // 2026-11-12、同じ世帯（親 e8c798cd と、incertotech へ転出した子5人）が、親の町では横に広い扇形、子の町では親を囲む小さな形になった。
  // 原因は、前に選んだ候補を世帯ごとに引き継いでいたこと（App.tsx の prevArc）。子が1人ずつ増えるのを見ていた町は、
  // 1人のとき（どの候補も同じ s）に選ばれた候補0を、s ≤ 1 のあいだ使い続けた。直したあとは引き継がない。
  const town = (parentId: string, kidIds: string[]): LNode[] => [
    { id: parentId, parent: null, order: 0, ...boxOf(0, parentId.slice(-8)) },
    ...kidIds.map((id, i) => ({ id, parent: parentId, order: i + 1, ...boxOf(1, id.slice(-8)) })),
  ];
  const KIDS = ["b599aaf0", "69d112e0", "97aec551", "c737a3ff", "9f68ddc0"];
  const KIDS6 = [...KIDS, "3e1d7a42"];
  const KIDS8 = [...KIDS6, "5c0ffee1", "d00dfeed"];
  const shape = (r: { nodes: Placed[] }) => r.nodes.map((n) => [n.depth, n.x.toFixed(3), n.y.toFixed(3), n.w, n.h].join(","));

  // 子5人と6人は 2026-11-21 から格子の固定の座標に置く。試験9〜11 の数字は弧の計算（余白を指定した呼び出し）で出し、直したときの記録として残す

  test("9. ID だけが違う同じ形の世帯は、同じ配置になる（弧の計算と、子5人、6人、8人の格子）", () => {
    // 別の ID は、子の ID の大小の順を元の世帯と逆にしてある。配置は生成順と箱の大きさで決まり、ID には左右されない。
    // 座標は生成順に並べて比べる（ID の順で子を並べ替えると、ここで食い違う）
    const renamed = (kids: string[]) => kids.map((_, i) => `z${String(kids.length - i).padStart(7, "0")}`);
    const inOrder = (r: { nodes: Placed[] }, ids: string[]) => ids.map((id) => { const n = get(r.nodes, id); return [n.depth, n.x.toFixed(3), n.y.toFixed(3), n.w, n.h].join(","); });
    const a = layoutFamily(town("e8c798cd", KIDS), RADIAL);
    const b = layoutFamily(town("0a1b2c3d", renamed(KIDS)), RADIAL);
    expect(inOrder(a, ["e8c798cd", ...KIDS])).toEqual(inOrder(b, ["0a1b2c3d", ...renamed(KIDS)]));
    expect(a.arcIndex).toBe(b.arcIndex);
    report.push({ ケース: 9, 元のIDの候補: a.arcIndex, 別のIDの候補: b.arcIndex, 候補ごと: JSON.stringify(a.candidates), ...a.metrics });
    for (const kids of [KIDS, KIDS6, KIDS8]) {
      const ga = layoutFamily(town("e8c798cd", kids));
      const gb = layoutFamily(town("0a1b2c3d", renamed(kids)));
      expect(inOrder(ga, ["e8c798cd", ...kids])).toEqual(inOrder(gb, ["0a1b2c3d", ...renamed(kids)]));
      expect(ga.arcIndex).toBe(-1);
      expect(gb.arcIndex).toBe(-1);
    }
  });

  test("10. 子が1人ずつ増えても、最初から5人（8人）いるのと同じ配置になる（前の候補を引き継がない）", () => {
    const grow = (kids: string[], opt?: { gap: number }) => {
      const picked: number[] = [];
      let last = layoutFamily(town("e8c798cd", kids.slice(0, 1)), opt);
      picked.push(last.arcIndex);
      for (let n = 2; n <= kids.length; n++) {
        last = layoutFamily(town("e8c798cd", kids.slice(0, n)), opt);
        picked.push(last.arcIndex);
      }
      expect(shape(last)).toEqual(shape(layoutFamily(town("e8c798cd", kids), opt)));
      return picked.join("→");
    };
    const radial = grow(KIDS, RADIAL);
    expect(radial).toBe("0→0→1→3→3");
    const fixed = grow(KIDS8);
    expect(fixed).toBe("-1→-1→-1→-1→-1→-1→-1→-1");
    report.push({ ケース: 10, "弧の計算で1→5人に選んだ候補": radial, "既定で1→8人に選んだ候補": fixed, ...layoutFamily(town("e8c798cd", KIDS8)).metrics });
  });

  test("11. 親1人・子5人の世帯の枠: 弧の計算では候補0の扇形 837×551 から候補3の 568×473 に小さくなる。格子では 578×278", () => {
    const r = layoutFamily(town("e8c798cd", KIDS), RADIAL);
    const before = r.candidates.find((c) => c.arcIndex === 0)!;
    const after = r.candidates.find((c) => c.arcIndex === r.arcIndex)!;
    const fb = groupSizeOf(before), fa = groupSizeOf(r.metrics);
    expect(fb).toEqual({ w: 837, h: 551 });
    expect(fa).toEqual({ w: 568, h: 473 });
    expect(groupSizeOf(after)).toEqual(fa);
    const areaB = fb.w * fb.h, areaA = fa.w * fa.h;
    expect(areaA).toBeLessThan(areaB * 0.65);
    const grid = groupSizeOf(layoutFamily(town("e8c798cd", KIDS)).metrics);
    expect(grid).toEqual({ w: 578, h: 278 });
    report.push({ ケース: 11, 直す前の枠: `${fb.w}×${fb.h}（${areaB}）`, 直した後の枠: `${fa.w}×${fa.h}（${areaA}）`, 面積の比: (areaA / areaB).toFixed(3), 格子の枠: `${grid.w}×${grid.h}`, ...r.metrics });
  });

  // 2026-11-13、本人が子1〜4人の位置を決めた。親の中心が (0,0)、y は下が正。card 176×96、余白 m 8 で、dx 92、dy 104、side 184
  // 2026-11-21、本人が子3人を、左、右、真下に変えた（真上、左下、右下から）。左右の子は親と同じ高さ、真下の子の x は親と同じ
  // 同じ日に、子4人を格子に変えた（左下 (-92, 104)、右下 (92, 104) から、左下 (-184, 108)、右下 (184, 108) へ）。4人は試験14で見る
  const SPEC: Record<number, [number, number][]> = {
    1: [[0, 104]],
    2: [[-92, 104], [92, 104]],
    3: [[-184, 0], [184, 0], [0, 104]],
  };
  // 本人の条件のまま書く: |xA-xB| >= w+m か |yA-yB| >= h+m
  const apart = (a: Placed, b: Placed) => Math.abs(a.x - b.x) >= 176 + 8 || Math.abs(a.y - b.y) >= 96 + 8;
  const SIZE: Record<number, { w: number; h: number }> = { 1: { w: 240, h: 274 }, 2: { w: 394, h: 274 }, 3: { w: 578, h: 274 } };

  for (const n of [1, 2, 3]) {
    test(`12-${n}. 子${n}人: 本人が決めた固定の座標に、兄弟の順で置く。どのカードの組も重ならない`, () => {
      expect(LAYOUT.card).toEqual({ w: 176, h: 96 });
      expect(LAYOUT.cardMargin).toBe(8);
      expect(childSlots(n)!.map((p) => [p.x, p.y])).toEqual(SPEC[n]);
      // 生成順をわざと入力の並びと逆にして、兄弟の順（order）で位置が決まることを見る
      const kids = KIDS.slice(0, n);
      const input = town("e8c798cd", kids).map((x, i) => (i === 0 ? x : { ...x, order: n + 1 - i }));
      const r = layoutFamily(input);
      const byOrder = [...kids].reverse();
      expect(get(r.nodes, "e8c798cd")).toMatchObject({ x: 0, y: 0, depth: 0 });
      expect(byOrder.map((id) => [get(r.nodes, id).x, get(r.nodes, id).y])).toEqual(SPEC[n]);
      for (let i = 0; i < r.nodes.length; i++) for (let j = i + 1; j < r.nodes.length; j++) expect(apart(r.nodes[i], r.nodes[j])).toBe(true);
      expect(ok(r.metrics)).toBe(true);
      expect(r.valid).toBe(true);
      expect(r.arcIndex).toBe(-1);
      expect(groupSizeOf(r.metrics)).toEqual(SIZE[n]);
      report.push({ ケース: `12-${n}`, 座標: JSON.stringify(byOrder.map((id) => [get(r.nodes, id).x, get(r.nodes, id).y])), 世帯の枠: `${SIZE[n].w}×${SIZE[n].h}`, ...r.metrics });
    });
  }

  test("12-3b. 子3人: 左右の子は親と同じ高さ、真下の子の x は親と同じ", () => {
    const r = layoutFamily(town("e8c798cd", KIDS.slice(0, 3)));
    const [l, rr, b] = KIDS.slice(0, 3).map((id) => get(r.nodes, id));
    expect([l.y, rr.y]).toEqual([0, 0]);
    expect(l.x).toBe(-rr.x);
    expect(b.x).toBe(0);
    expect(b.y).toBeGreaterThan(0);
    expect(r.nodes.some((n) => n.y < 0)).toBe(false); // 上には置かない
  });

  test("13. 子9人以上の世帯は、今の計算のまま（弧の候補から選ぶ）", () => {
    expect(childSlots(9)).toBeNull();
    const nine = layoutFamily(town("e8c798cd", [...KIDS8, "feedface"]));
    expect(nine.arcIndex).toBeGreaterThanOrEqual(0);
    expect(nine.candidates.length).toBe(LAYOUT.arcLimits.length);
    expect(ok(nine.metrics)).toBe(true);
    const nineGrand = layoutFamily(family([["p", null], ...Array.from({ length: 9 }, (_, i) => [`c${i}`, "p"] as [string, string]), ["c0-1", "c0"]]));
    expect(nineGrand.arcIndex).toBeGreaterThanOrEqual(0);
    // ゴーストの世帯も同じ固定の座標になる（親の町と子の町で同じ形）
    const local = layoutFamily(town("e8c798cd", KIDS.slice(0, 4).map((k) => `ghost:${k}`)));
    const remote = layoutFamily(town("ghost:e8c798cd", KIDS.slice(0, 4)));
    expect(shape(local)).toEqual(shape(remote));
    expect(local.arcIndex).toBe(-1);
  });

  // 2026-11-21、本人が子5人と6人の位置を決めた。左右の子は親と同じ高さ、上下の段は左右の列（x = ±184）と真ん中（x = 0）にそろえる。
  // 段の間は 108（h+m の 104 では、親から角の子への紐が左右の子の箱の余白 5px をかすめる。layout.ts の gridRowGap）
  // 同じ日に、4人、7人、8人も同じ流れで格子にした。4人は6人から上の段を除いた形、7人は6人の下の段に真下を足した形、
  // 8人は7人の上の段に真上を足し、親の周りの8か所を全部埋めた形
  const GRID: Record<number, [number, number][]> = {
    4: [[-184, 0], [184, 0], [-184, 108], [184, 108]],
    5: [[-184, 0], [184, 0], [-184, 108], [0, 108], [184, 108]],
    6: [[-184, -108], [184, -108], [-184, 0], [184, 0], [-184, 108], [184, 108]],
    7: [[-184, -108], [184, -108], [-184, 0], [184, 0], [-184, 108], [0, 108], [184, 108]],
    8: [[-184, -108], [0, -108], [184, -108], [-184, 0], [184, 0], [-184, 108], [0, 108], [184, 108]],
  };
  const GRID_SIZE: Record<number, { w: number; h: number }> = {
    4: { w: 578, h: 278 }, 5: { w: 578, h: 278 }, 6: { w: 578, h: 386 }, 7: { w: 578, h: 386 }, 8: { w: 578, h: 386 },
  };
  // 下の段と上の段の枚数
  const ROWS: Record<number, { below: number; above: number }> = {
    4: { below: 2, above: 0 }, 5: { below: 3, above: 0 }, 6: { below: 2, above: 2 }, 7: { below: 3, above: 2 }, 8: { below: 3, above: 3 },
  };
  const KIDS_GRID = [...KIDS8];

  for (const n of [4, 5, 6, 7, 8]) {
    test(`14-${n}. 子${n}人: 格子の固定の座標に置く。左右の子は親と同じ高さで、段と列がそろう`, () => {
      expect(gridRowGap()).toBe(108);
      expect(childSlots(n)!.map((p) => [p.x, p.y])).toEqual(GRID[n]);
      const kids = KIDS_GRID.slice(0, n);
      // 生成順をわざと入力の並びと逆にして、兄弟の順（order）で位置が決まることを見る
      const input = town("e8c798cd", kids).map((x, i) => (i === 0 ? x : { ...x, order: n + 1 - i }));
      const r = layoutFamily(input);
      const p = get(r.nodes, "e8c798cd");
      const byOrder = [...kids].reverse().map((id) => get(r.nodes, id));
      expect(byOrder.map((k) => [k.x, k.y])).toEqual(GRID[n]);
      const left = byOrder.filter((k) => k.x < 0), right = byOrder.filter((k) => k.x > 0);
      // 左右の子（x が ±184 で、y が 0）は親と同じ高さ
      const sides = byOrder.filter((k) => k.y === p.y);
      expect(sides.map((k) => k.x).sort((a, b) => a - b)).toEqual([-184, 184]);
      // 左の列と右の列の x がそろい、左右対称
      expect(new Set(left.map((k) => k.x)).size).toBe(1);
      expect(new Set(right.map((k) => k.x)).size).toBe(1);
      expect(left[0].x).toBe(-right[0].x);
      // 下の段の y がそろう。上の段があれば上の段もそろい、上下が親から同じ距離
      const below = byOrder.filter((k) => k.y > p.y), above = byOrder.filter((k) => k.y < p.y);
      expect({ below: below.length, above: above.length }).toEqual(ROWS[n]);
      expect(new Set(below.map((k) => k.y)).size).toBe(1);
      if (above.length) {
        expect(new Set(above.map((k) => k.y)).size).toBe(1);
        expect(above[0].y).toBe(-below[0].y);
      }
      // 上下の段の x は、左右の列か真ん中にそろう。真ん中の列の子（7人の真下、8人の真上と真下）は親と同じ x
      for (const k of [...below, ...above]) expect([-184, 0, 184]).toContain(k.x);
      const middle = byOrder.filter((k) => k.x === p.x);
      expect(middle.length).toBe({ 4: 0, 5: 1, 6: 0, 7: 1, 8: 2 }[n]!);
      // 8人は親の周りの8か所（左上、上、右上、左、右、左下、下、右下）を1人ずつ埋める
      if (n === 8) {
        const cells = new Set(byOrder.map((k) => `${Math.sign(k.x)},${Math.sign(k.y)}`));
        expect(cells.size).toBe(8);
        expect(cells.has("0,0")).toBe(false);
      }
      for (let i = 0; i < r.nodes.length; i++) for (let j = i + 1; j < r.nodes.length; j++) expect(apart(r.nodes[i], r.nodes[j])).toBe(true);
      expect(ok(r.metrics)).toBe(true);
      expect(r.valid).toBe(true);
      expect(r.arcIndex).toBe(-1);
      expect(groupSizeOf(r.metrics)).toEqual(GRID_SIZE[n]);
      report.push({ ケース: `14-${n}`, 座標: JSON.stringify(byOrder.map((k) => [k.x, k.y])), 世帯の枠: `${GRID_SIZE[n].w}×${GRID_SIZE[n].h}`, ...r.metrics });
    });
  }

  /** 親 p と子 k1…kn に、孫を足した世帯。grand は「何番目の子に何人」 */
  const gridFamily = (n: number, grand: Record<number, number>, deep: Record<number, number> = {}): LNode[] => {
    const rows: [string, string | null][] = [["p", null]];
    for (let i = 1; i <= n; i++) rows.push([`k${i}`, "p"]);
    for (const [i, m] of Object.entries(grand)) for (let j = 1; j <= m; j++) {
      rows.push([`k${i}-g${j}`, `k${i}`]);
      // deep は「何番目の子の1人目の孫に、ひ孫を何人」
      if (j === 1) for (let d = 1; d <= (deep[Number(i)] ?? 0); d++) rows.push([`k${i}-g1-d${d}`, `k${i}-g1`]);
    }
    return family(rows);
  };

  // 画面の確かめ（docs/shots/2026-11-21-grid-*.png）と同じ形。1人は孫2人、2人は左の子に孫2人、3人は右の子に孫2人、
  // 4人は右の子に孫1人（本人の画面の形）、5人は左下の子に孫2人、6人は左上の子に孫1人と右下の子に孫2人
  // 6人の上の段の2人（角度が ±π の側）に孫がいる形と、ひ孫がいる形も見る
  // 4人は右の子と左下の子に孫、7人は左上の子と真下の子に孫、7人と8人の全員に孫2人、
  // 8人は上の段の3人（真上の子の角度はちょうど π）に孫、真上の子にひ孫
  const GRAND_CASES: { n: number; grand: Record<number, number>; deep?: Record<number, number>; label: string }[] = [
    { n: 1, grand: { 1: 2 }, label: "1" },
    { n: 2, grand: { 1: 2 }, label: "2" },
    { n: 3, grand: { 2: 2 }, label: "3" },
    { n: 3, grand: { 1: 1, 2: 1, 3: 3 }, deep: { 3: 1 }, label: "3-全員とひ孫" },
    { n: 4, grand: { 2: 1 }, label: "4" },
    { n: 5, grand: { 3: 2 }, label: "5" },
    { n: 6, grand: { 1: 1, 6: 2 }, label: "6" },
    { n: 6, grand: { 1: 2, 2: 2 }, label: "6-上の段" },
    { n: 5, grand: { 1: 2, 4: 1 }, deep: { 1: 2 }, label: "5-ひ孫" },
    { n: 6, grand: { 2: 2 }, deep: { 2: 1 }, label: "6-ひ孫" },
    { n: 4, grand: { 2: 2, 3: 1 }, label: "4-右と左下" },
    { n: 7, grand: { 1: 1, 6: 2 }, label: "7" },
    { n: 7, grand: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2 }, label: "7-全員" },
    { n: 8, grand: { 1: 2, 2: 2, 3: 2 }, label: "8-上の段" },
    { n: 8, grand: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2 }, label: "8-全員" },
    { n: 8, grand: { 2: 2, 7: 1 }, deep: { 2: 1 }, label: "8-ひ孫" },
  ];
  for (const { n, grand, deep, label } of GRAND_CASES) {
    test(`15-${label}. 子${n}人で孫がいる（${JSON.stringify(grand)}${deep ? `、ひ孫 ${JSON.stringify(deep)}` : ""}）: 子は格子のまま、孫より下はその子の外側に並ぶ`, () => {
      const input = gridFamily(n, grand, deep);
      const r = layoutFamily(input);
      const radial = layoutFamily(input, RADIAL);
      expect(r.arcIndex).toBe(-1);
      expect(ok(r.metrics)).toBe(true);
      expect(r.valid).toBe(true);
      expect(Array.from({ length: n }, (_, i) => get(r.nodes, `k${i + 1}`)).map((k) => [k.x, k.y])).toEqual(childSlots(n)!.map((q) => [q.x, q.y]));
      for (const g of r.nodes.filter((x) => x.depth >= 2)) {
        const k = get(r.nodes, g.parent!);
        // 根から見て親より遠く、親の向きから 45 度以内
        expect(Math.hypot(g.x, g.y)).toBeGreaterThan(Math.hypot(k.x, k.y));
        expect(Math.abs(g.angle - k.angle)).toBeLessThan(Math.PI / 4);
      }
      if (deep) expect(Math.max(...r.nodes.map((x) => x.depth))).toBe(3);
      report.push({ ケース: `15-${label}`, 孫: JSON.stringify(grand), ひ孫: JSON.stringify(deep ?? {}), 格子のs: r.metrics.s.toFixed(3), 格子の枠: JSON.stringify(groupSizeOf(r.metrics)), 弧の計算のs: radial.metrics.s.toFixed(3), 弧の計算の枠: JSON.stringify(groupSizeOf(radial.metrics)), ...r.metrics });
    });
  }

  test("16. 孫が多くても、子の位置は変えず、孫までの距離を広げて検査を通す（弧の計算には戻さない）", () => {
    for (const n of [3, 4, 5, 6, 7, 8]) {
      const input = gridFamily(n, { 1: 8, 3: 8 });
      const r = layoutFamily(input);
      const radial = layoutFamily(input, RADIAL);
      expect(r.arcIndex).toBe(-1);
      expect(ok(r.metrics)).toBe(true);
      expect(r.metrics.adjustments).toBeGreaterThan(0);
      expect(Array.from({ length: n }, (_, i) => get(r.nodes, `k${i + 1}`)).map((k) => [k.x, k.y])).toEqual(childSlots(n)!.map((q) => [q.x, q.y]));
      report.push({ ケース: `16-${n}`, 孫: "1人目と3人目に8人ずつ", 格子のs: r.metrics.s.toFixed(3), 格子の枠: JSON.stringify(groupSizeOf(r.metrics)), 弧の計算のs: radial.metrics.s.toFixed(3), 弧の計算の枠: JSON.stringify(groupSizeOf(radial.metrics)), ...r.metrics });
    }
  });

  test("17. 孫が増えても減っても、子の位置は孫がいないときと同じ", () => {
    for (let n = 1; n <= 8; n++) {
      const kidsAt = (r: { nodes: Placed[] }) => Array.from({ length: n }, (_, i) => get(r.nodes, `k${i + 1}`)).map((k) => [k.x, k.y]);
      const none = layoutFamily(gridFamily(n, {}));
      for (const grand of [{ 1: 1 }, { [n]: 3 }, Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, 2]))]) {
        expect(kidsAt(layoutFamily(gridFamily(n, grand)))).toEqual(kidsAt(none));
      }
    }
  });

  test("結果の表", () => {
    for (const r of report) {
      const { overlaps, crossings, edgeThroughNode, interleave, s, width, height, adjustments, ...rest } = r as Record<string, number>;
      console.log(JSON.stringify({ ...rest, 重なり: overlaps, 交差: crossings, 線が箱を通る: edgeThroughNode, 混ざり: interleave, s: Number(s).toFixed(3), 幅: Number(width).toFixed(0), 高さ: Number(height).toFixed(0), 調整: adjustments }));
    }
  });
});
