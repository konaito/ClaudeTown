// 配置計算だけの検証。docs/design/physics-layout.md の 10 の8ケースを数値で確かめる。
// 実行: bun test src/layout
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { layoutFamily, type LNode, type Placed } from "./layout";
import { boxOf } from "./params";

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
    const added = layoutFamily(family([...base, ["d", "p"]]), { prevArcIndex: r0.arcIndex });
    const removed = layoutFamily(family(base.filter(([id]) => id !== "b1")), { prevArcIndex: r0.arcIndex });
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

  test("結果の表", () => {
    for (const r of report) {
      const { overlaps, crossings, edgeThroughNode, interleave, s, width, height, adjustments, ...rest } = r as Record<string, number>;
      console.log(JSON.stringify({ ...rest, 重なり: overlaps, 交差: crossings, 線が箱を通る: edgeThroughNode, 混ざり: interleave, s: Number(s).toFixed(3), 幅: Number(width).toFixed(0), 高さ: Number(height).toFixed(0), 調整: adjustments }));
    }
  });
});
