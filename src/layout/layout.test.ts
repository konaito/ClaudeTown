// 配置計算だけの検証。docs/design/physics-layout.md の 10 の8ケースを数値で確かめる。
// 実行: bun test src/layout
import { describe, expect, spyOn, test } from "bun:test";
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

  test("5. 一方の子にだけ孫が多い: その枝に広い角度が割り当たる", () => {
    const rows: [string, string | null][] = [["p", null], ["a", "p"], ["b", "p"], ["c", "p"]];
    for (let i = 0; i < 8; i++) rows.push([`a${i}`, "a"]);
    rows.push(["b0", "b"], ["c0", "c"]);
    const r = layoutFamily(family(rows));
    const span = (pre: string) => {
      const as = r.nodes.filter((n) => n.id.startsWith(pre) && n.depth === 2).map((n) => n.angle);
      return deg(Math.max(...as) - Math.min(...as));
    };
    const gapAB = deg(get(r.nodes, "b").angle - get(r.nodes, "a").angle), gapBC = deg(get(r.nodes, "c").angle - get(r.nodes, "b").angle);
    report.push({ ケース: 5, a枝の孫の広がり: span("a").toFixed(1), "a→bの角度": gapAB.toFixed(1), "b→cの角度": gapBC.toFixed(1), ...r.metrics });
    expect(gapAB).toBeGreaterThan(gapBC * 1.5);
    expect(ok(r.metrics)).toBe(true);
  });

  test("6. 深さ4まで・合計25体: 世代と親子を追える（重なり・交差・線の通り抜け・混ざりが0）", () => {
    const rows: [string, string | null][] = [["meta-0a", null], ["tangle-harvest", "meta-0a"]];
    for (let i = 1; i <= 4; i++) {
      rows.push([`miner-${i}`, "tangle-harvest"]);
      for (let j = 1; j <= 4; j++) rows.push([`miner-${i}.${j}`, `miner-${i}`]);
    }
    rows.push(["deep-1", "miner-2.1"], ["deep-2", "miner-2.1"], ["reviewer", "meta-0a"]);
    const r = layoutFamily(family(rows));
    report.push({ ケース: 6, 体数: rows.length, 最大の深さ: Math.max(...r.nodes.map((n) => n.depth)), 候補: r.arcIndex, 候補ごと: JSON.stringify(r.candidates), ...r.metrics });
    expect(rows.length).toBe(25);
    expect(ok(r.metrics)).toBe(true);
  });

  test("7. 子の追加・削除: 回転や反転をせず、角度の順が保たれる", () => {
    const base: [string, string | null][] = [["p", null], ["a", "p"], ["b", "p"], ["c", "p"], ["a1", "a"], ["a2", "a"], ["b1", "b"]];
    const r0 = layoutFamily(family(base));
    const added = layoutFamily(family([...base, ["d", "p"]]));
    const removed = layoutFamily(family(base.filter(([id]) => id !== "b1")));
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

  test("8. 長い名前: 実際の箱で重なりを見つけて解消する", () => {
    const rows: [string, string | null][] = [["p", null], ["a", "p"], ["b", "p"]];
    const names: Record<string, string> = {};
    for (let i = 0; i < 6; i++) { rows.push([`a${i}`, "a"]); names[`a${i}`] = `long-worker-name-${i}-review`; }
    for (let i = 0; i < 6; i++) { rows.push([`b${i}`, "b"]); names[`b${i}`] = `長い名前の孫その${i}`; }
    const short = layoutFamily(family(rows));
    const long = layoutFamily(family(rows, names));
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
  const shape = (r: { nodes: Placed[] }) => r.nodes.map((n) => [n.depth, n.x.toFixed(3), n.y.toFixed(3), n.w, n.h].join(","));

  // 子5人と6人は 2026-11-21 から格子の固定の座標に置く。試験9〜11 の数字は弧の計算（余白を指定した呼び出し）で出し、直したときの記録として残す
  const RADIAL = { gap: LAYOUT.gap };

  test("9. 親の町（親が本物、子がゴースト）と子の町（親がゴースト、子が本物）で同じ配置になる（弧の計算と、子5人と6人の格子）", () => {
    const local = layoutFamily(town("e8c798cd", KIDS.map((k) => `ghost:${k}`)), RADIAL);
    const remote = layoutFamily(town("ghost:e8c798cd", KIDS), RADIAL);
    // ゴーストの箱は本物と同じ大きさ（深さ 0、1 はカード、2 以降は boxOf。App.tsx の GhostCard も同じ値で描く）
    expect(boxOf(1, "ghost:b599aaf0")).toEqual(boxOf(1, "b599aaf0"));
    expect(shape(local)).toEqual(shape(remote));
    expect(local.arcIndex).toBe(remote.arcIndex);
    report.push({ ケース: 9, 親の町の候補: local.arcIndex, 子の町の候補: remote.arcIndex, 候補ごと: JSON.stringify(local.candidates), ...local.metrics });
    for (const kids of [KIDS, KIDS6]) {
      const gl = layoutFamily(town("e8c798cd", kids.map((k) => `ghost:${k}`)));
      const gr = layoutFamily(town("ghost:e8c798cd", kids));
      expect(shape(gl)).toEqual(shape(gr));
      expect(gl.arcIndex).toBe(-1);
      expect(gr.arcIndex).toBe(-1);
    }
  });

  test("10. 子が1人ずつ増えても、最初から5人（6人）いるのと同じ配置になる（前の候補を引き継がない）", () => {
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
    const fixed = grow(KIDS6);
    expect(fixed).toBe("-1→-1→-1→-1→-1→-1");
    report.push({ ケース: 10, "弧の計算で1→5人に選んだ候補": radial, "既定で1→6人に選んだ候補": fixed, ...layoutFamily(town("e8c798cd", KIDS6)).metrics });
  });

  test("11. 親1人・子5人の世帯の枠: 弧の計算では候補0の扇形 878×580 から候補3の 609×502 に小さくなる。格子では 619×307", () => {
    const r = layoutFamily(town("e8c798cd", KIDS), RADIAL);
    const before = r.candidates.find((c) => c.arcIndex === 0)!;
    const after = r.candidates.find((c) => c.arcIndex === r.arcIndex)!;
    const fb = groupSizeOf(before), fa = groupSizeOf(r.metrics);
    expect(fb).toEqual({ w: 878, h: 580 });
    expect(fa).toEqual({ w: 609, h: 502 });
    expect(groupSizeOf(after)).toEqual(fa);
    const areaB = fb.w * fb.h, areaA = fa.w * fa.h;
    expect(areaA).toBeLessThan(areaB * 0.65);
    const grid = groupSizeOf(layoutFamily(town("e8c798cd", KIDS)).metrics);
    expect(grid).toEqual({ w: 619, h: 307 });
    report.push({ ケース: 11, 直す前の枠: `${fb.w}×${fb.h}（${areaB}）`, 直した後の枠: `${fa.w}×${fa.h}（${areaA}）`, 面積の比: (areaA / areaB).toFixed(3), 格子の枠: `${grid.w}×${grid.h}`, ...r.metrics });
  });

  // 2026-11-13、本人が子1〜4人の位置を決めた。親の中心が (0,0)、y は下が正。card 176×96、余白 m 8 で、dx 92、dy 104、side 184
  const SPEC: Record<number, [number, number][]> = {
    1: [[0, 104]],
    2: [[-92, 104], [92, 104]],
    3: [[0, -104], [-92, 104], [92, 104]],
    4: [[-184, 0], [184, 0], [-92, 104], [92, 104]],
  };
  // 本人の条件のまま書く: |xA-xB| >= w+m か |yA-yB| >= h+m
  const apart = (a: Placed, b: Placed) => Math.abs(a.x - b.x) >= 176 + 8 || Math.abs(a.y - b.y) >= 96 + 8;
  const SIZE: Record<number, { w: number; h: number }> = { 1: { w: 251, h: 303 }, 2: { w: 435, h: 303 }, 3: { w: 435, h: 407 }, 4: { w: 619, h: 303 } };

  for (const n of [1, 2, 3, 4]) {
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

  test("13. 子7人以上の世帯と、子1〜4人で孫がいる世帯は、今の計算のまま（弧の候補から選ぶ）", () => {
    expect(childSlots(7)).toBeNull();
    const seven = layoutFamily(town("e8c798cd", [...KIDS6, "5c0ffee1"]));
    expect(seven.arcIndex).toBeGreaterThanOrEqual(0);
    expect(seven.candidates.length).toBe(LAYOUT.arcLimits.length);
    expect(ok(seven.metrics)).toBe(true);
    const withGrand = layoutFamily(family([["p", null], ["a", "p"], ["b", "p"], ["a1", "a"]]));
    expect(withGrand.arcIndex).toBeGreaterThanOrEqual(0);
    expect(withGrand.fallback).toBeUndefined();
    expect(ok(withGrand.metrics)).toBe(true);
    // ゴーストの世帯も同じ固定の座標になる（親の町と子の町で同じ形）
    const local = layoutFamily(town("e8c798cd", KIDS.slice(0, 4).map((k) => `ghost:${k}`)));
    const remote = layoutFamily(town("ghost:e8c798cd", KIDS.slice(0, 4)));
    expect(shape(local)).toEqual(shape(remote));
    expect(local.arcIndex).toBe(-1);
  });

  // 2026-11-21、本人が子5人と6人の位置を決めた。左右の子は親と同じ高さ、上下の段は左右の列（x = ±184）と真ん中（x = 0）にそろえる。
  // 段の間は 108（h+m の 104 では、親から角の子への紐が左右の子の箱の余白 5px をかすめる。layout.ts の gridRowGap）
  const GRID: Record<number, [number, number][]> = {
    5: [[-184, 0], [184, 0], [-184, 108], [0, 108], [184, 108]],
    6: [[-184, -108], [184, -108], [-184, 0], [184, 0], [-184, 108], [184, 108]],
  };
  const GRID_SIZE: Record<number, { w: number; h: number }> = { 5: { w: 619, h: 307 }, 6: { w: 619, h: 415 } };

  for (const n of [5, 6]) {
    test(`14-${n}. 子${n}人: 格子の固定の座標に置く。左右の子は親と同じ高さで、段と列がそろう`, () => {
      expect(gridRowGap()).toBe(108);
      expect(childSlots(n)!.map((p) => [p.x, p.y])).toEqual(GRID[n]);
      const kids = KIDS6.slice(0, n);
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
      // 下の段の y がそろう（5人は3枚、6人は2枚）。6人は上の段もそろい、上下が親から同じ距離
      const below = byOrder.filter((k) => k.y > p.y), above = byOrder.filter((k) => k.y < p.y);
      expect(below.length).toBe(n === 5 ? 3 : 2);
      expect(new Set(below.map((k) => k.y)).size).toBe(1);
      expect(above.length).toBe(n === 5 ? 0 : 2);
      if (n === 6) expect(above[0].y).toBe(-below[0].y);
      // 上下の段の x は、左右の列か真ん中にそろう
      for (const k of [...below, ...above]) expect([-184, 0, 184]).toContain(k.x);
      for (let i = 0; i < r.nodes.length; i++) for (let j = i + 1; j < r.nodes.length; j++) expect(apart(r.nodes[i], r.nodes[j])).toBe(true);
      expect(ok(r.metrics)).toBe(true);
      expect(r.valid).toBe(true);
      expect(r.arcIndex).toBe(-1);
      expect(r.fallback).toBeUndefined();
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

  // 画面の確かめ（docs/shots/2026-11-21-grid-*.png）と同じ形。5人は左下の子に孫2人、6人は左上の子に孫1人と右下の子に孫2人
  // 6人の上の段の2人（角度が ±π の側）に孫がいる形と、ひ孫がいる形も見る
  const GRAND_CASES: { n: 5 | 6; grand: Record<number, number>; deep?: Record<number, number>; label: string }[] = [
    { n: 5, grand: { 3: 2 }, label: "5" },
    { n: 6, grand: { 1: 1, 6: 2 }, label: "6" },
    { n: 6, grand: { 1: 2, 2: 2 }, label: "6-上の段" },
    { n: 5, grand: { 1: 2, 4: 1 }, deep: { 1: 2 }, label: "5-ひ孫" },
    { n: 6, grand: { 2: 2 }, deep: { 2: 1 }, label: "6-ひ孫" },
  ];
  for (const { n, grand, deep, label } of GRAND_CASES) {
    test(`15-${label}. 子${n}人で孫がいる（${JSON.stringify(grand)}${deep ? `、ひ孫 ${JSON.stringify(deep)}` : ""}）: 子は格子のまま、孫より下はその子の外側に並ぶ`, () => {
      const input = gridFamily(n, grand, deep);
      const r = layoutFamily(input);
      const radial = layoutFamily(input, RADIAL);
      expect(r.arcIndex).toBe(-1);
      expect(r.fallback).toBeUndefined();
      expect(ok(r.metrics)).toBe(true);
      expect(r.valid).toBe(true);
      expect(Array.from({ length: n }, (_, i) => get(r.nodes, `k${i + 1}`)).map((k) => [k.x, k.y])).toEqual(GRID[n]);
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

  test("16. 子5人と6人で孫が多く、格子では検査を通らない世帯は、弧の計算に戻し、理由を fallback に残す", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const n of [5, 6]) {
        const input = gridFamily(n, { 1: 8, 3: 8 });
        const r = layoutFamily(input);
        expect(r.arcIndex).toBeGreaterThanOrEqual(0);
        expect(r.fallback).toBeDefined();
        expect(r.fallback!.slots).toBe(n);
        expect(r.fallback!.adjustments).toBe(LAYOUT.maxAdjust);
        expect(r.fallback!.overlaps + r.fallback!.crossings + r.fallback!.edgeThroughNode + r.fallback!.interleave).toBeGreaterThan(0);
        expect(ok(r.metrics)).toBe(true);
        // 戻した結果は、余白を指定して弧の計算だけをした結果と同じ
        expect(shape(r)).toEqual(shape(layoutFamily(input, RADIAL)));
        report.push({ ケース: `16-${n}`, 戻した理由: JSON.stringify(r.fallback), 戻した先の候補: r.arcIndex, ...r.metrics });
      }
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("結果の表", () => {
    for (const r of report) {
      const { overlaps, crossings, edgeThroughNode, interleave, s, width, height, adjustments, ...rest } = r as Record<string, number>;
      console.log(JSON.stringify({ ...rest, 重なり: overlaps, 交差: crossings, 線が箱を通る: edgeThroughNode, 混ざり: interleave, s: Number(s).toFixed(3), 幅: Number(width).toFixed(0), 高さ: Number(height).toFixed(0), 調整: adjustments }));
    }
  });
});
