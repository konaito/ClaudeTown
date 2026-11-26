// 子1〜8人の世帯（childSlots の格子）に孫やひ孫を付けた代表の形で、世帯の枠（groupSizeOf）を測る。
// 孫の置き方を変える前と後で同じ形を測り、寸法を並べるための道具（docs/design/geometric-layout.md の 2026-11-26 の節）。
// 実行: bun scripts/measure-grand-layout.ts [--json <書き出し先>] [--compare <前の json>]
//   --json は形ごとの結果を書き出す。--compare は前の結果と並べ、面積が大きくなった形を数える（あれば終了コード 1）
import { readFileSync, writeFileSync } from "node:fs";
import { layoutFamily, type LNode } from "../src/layout/layout";
import { boxOf, groupSizeOf } from "../src/layout/params";

type Row = { key: string; valid: boolean; w: number; h: number; area: number; s: number; grid?: string; ms: number };

/** [id, 親, 名前] の並びから入力を作る。並び順を生成順にする */
function family(rows: [string, string | null, string][]): LNode[] {
  const depth = new Map<string, number>();
  for (const [id, p] of rows) depth.set(id, p ? depth.get(p)! + 1 : 0);
  return rows.map(([id, p, name], i) => {
    const b = boxOf(depth.get(id)!, name);
    return { id, parent: p, order: i, w: b.w, h: b.h };
  });
}

/** 子 n 人。grand は「何番目の子（1から）に何人」。deep は「何番目の子の1人目の孫にひ孫を何人」 */
function shape(n: number, grand: Record<number, number>, name: string, deep: Record<number, number> = {}) {
  const rows: [string, string | null, string][] = [["p", null, "meta"]];
  for (let i = 1; i <= n; i++) rows.push([`k${i}`, "p", "child"]);
  for (const [i, m] of Object.entries(grand)) for (let j = 1; j <= m; j++) {
    rows.push([`k${i}-g${j}`, `k${i}`, name]);
    if (j === 1) for (let d = 1; d <= (deep[Number(i)] ?? 0); d++) rows.push([`k${i}-g1-d${d}`, `k${i}-g1`, name]);
  }
  return family(rows);
}

const shapes: { key: string; nodes: LNode[] }[] = [];
// 本人のスクショ（2026-11-26 22:45）と同じ形。子3人の真下の子に、名前 general-purpose の孫5人
shapes.push({ key: "スクショ: 子3人の真下に孫5人（general-purpose）", nodes: shape(3, { 3: 5 }, "general-purpose") });
for (const name of ["general-purpose", "meta"]) {
  for (let n = 1; n <= 8; n++) for (let m = 1; m <= 8; m++) {
    // 1人の子にだけ孫 m 人（どの位置の子でも）
    for (let i = 1; i <= n; i++) shapes.push({ key: `子${n}人の${i}人目に孫${m}人（${name}）`, nodes: shape(n, { [i]: m }, name) });
    // 全員に孫 m 人
    shapes.push({ key: `子${n}人の全員に孫${m}人（${name}）`, nodes: shape(n, Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, m])), name) });
  }
  // 隣り合う2人と3人に孫 m 人ずつ（枝どうしが場所を取り合う形）
  for (let n = 2; n <= 8; n++) for (let i = 1; i <= n; i++) for (let m = 1; m <= 8; m++) {
    const j = (i % n) + 1, k = (j % n) + 1;
    shapes.push({ key: `子${n}人の${i}人目と${j}人目に孫${m}人ずつ（${name}）`, nodes: shape(n, { [i]: m, [j]: m }, name) });
    if (n >= 3) shapes.push({ key: `子${n}人の${i}、${j}、${k}人目に孫${m}人ずつ（${name}）`, nodes: shape(n, { [i]: m, [j]: m, [k]: m }, name) });
  }
  // 試験16の形。1人目と3人目に孫8人ずつ
  for (let n = 3; n <= 8; n++) shapes.push({ key: `子${n}人の1人目と3人目に孫8人ずつ（${name}）`, nodes: shape(n, { 1: 8, 3: 8 }, name) });
  // スクショの形に、左の子（と右の子）の孫を足した形
  for (let m = 1; m <= 5; m++) {
    shapes.push({ key: `スクショに左の子の孫${m}人（${name}）`, nodes: shape(3, { 1: m, 3: 5 }, name) });
    shapes.push({ key: `スクショに左右の子の孫${m}人ずつ（${name}）`, nodes: shape(3, { 1: m, 2: m, 3: 5 }, name) });
  }
  // ひ孫あり。i 番目の子に孫2人、その1人目にひ孫 x 人
  for (let n = 1; n <= 8; n++) for (let i = 1; i <= n; i++) for (const x of [1, 3, 6]) {
    shapes.push({ key: `子${n}人の${i}人目に孫2人とひ孫${x}人（${name}）`, nodes: shape(n, { [i]: 2 }, name, { [i]: x }) });
  }
}

const rows: Row[] = shapes.map(({ key, nodes }) => {
  // 時間は同じ形を5回計算した中央値（layoutOf は描画の中で同期に呼ばれるので、重い形を見つける）
  const times: number[] = [];
  let r = layoutFamily(nodes);
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); r = layoutFamily(nodes); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  const g = groupSizeOf(r.metrics);
  return { key, valid: r.valid, w: g.w, h: g.h, area: g.w * g.h, s: Number(r.metrics.s.toFixed(3)), grid: (r as { grid?: string }).grid, ms: Number(times[2].toFixed(2)) };
});

const args = process.argv.slice(2);
const out = args.indexOf("--json") >= 0 ? args[args.indexOf("--json") + 1] : null;
const cmp = args.indexOf("--compare") >= 0 ? args[args.indexOf("--compare") + 1] : null;
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
const slow = [...rows].sort((a, b) => b.ms - a.ms).slice(0, 3);
console.log(`計算の時間（中央値）: 一番重い形 ${slow.map((r) => `${r.key} ${r.ms}ms`).join("、")}`);
const picks = new Map<string, number>();
for (const r of rows) picks.set(r.grid ?? "-", (picks.get(r.grid ?? "-") ?? 0) + 1);
console.log(`選んだ置き方: ${[...picks].map(([k, v]) => `${k} ${v}`).join("、")}`);
if (!cmp) {
  for (const r of rows.slice(0, 1)) console.log(JSON.stringify(r));
  console.log(`形 ${rows.length} 件、検査に通らない形 ${rows.filter((r) => !r.valid).length} 件`);
  process.exit(0);
}
const before = new Map((JSON.parse(readFileSync(cmp, "utf8")) as Row[]).map((r) => [r.key, r]));
let bigger = 0, smaller = 0, same = 0, invalid = 0;
const ratios: number[] = [];
for (const r of rows) {
  const b = before.get(r.key);
  if (!b) throw new Error(`前の結果に無い形: ${r.key}`);
  if (!r.valid) invalid++;
  ratios.push(r.area / b.area);
  if (r.area > b.area) { bigger++; console.log(`大きくなった: ${r.key} ${b.w}×${b.h} → ${r.w}×${r.h}`); }
  else if (r.area < b.area) smaller++;
  else same++;
}
ratios.sort((a, b) => a - b);
console.log(`形 ${rows.length} 件: 小さくなった ${smaller}、同じ ${same}、大きくなった ${bigger}、検査に通らない ${invalid}`);
console.log(`面積の比（後/前）: 最小 ${ratios[0].toFixed(3)}、中央 ${ratios[Math.floor(ratios.length / 2)].toFixed(3)}、最大 ${ratios[ratios.length - 1].toFixed(3)}`);
process.exit(bigger || invalid ? 1 : 0);
