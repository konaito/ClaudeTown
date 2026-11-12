// 家族の木の配置（決定論的な幾何）。DOM に触れず、同じ入力から同じ座標を返す。乱数と時刻は使わない。
//
// 1. 世代ごとの半径 R[g] を、箱の高さと余白から決める（中心は家族の一番上の親）
// 2. 葉から順に、各枝が必要とする角度幅を計算する（自分の箱の幅 2·arcsin(r/R) と、子の枝の合計の大きいほう）
// 3. 根の子は下向き（0 度）を中心に、孫より下は親の角度を中心に、必要な幅だけ空けて並べる
// 4. 角度と半径から座標を出す（下向きが 0 度、右が正。x = R·sinθ、y = R·cosθ）
// 5. 実際の矩形で重なりを検査し、残れば決まった順序で角度の余白、次に半径を広げてやり直す
// 6. 兄弟を並べる弧の上限を変えた候補を作り、検査を通るもののうち s が一番小さいものを選ぶ。
//    前に選んだ候補は引き継がない。同じ顔ぶれなら、どの町で、どの順で増えても同じ配置になる（docs/design/geometric-layout.md の末尾）

import { LAYOUT } from "./params";

export type LNode = {
  id: string;
  parent: string | null;
  /** 兄弟の並びの順。生成順（startedAt）と ID で決める */
  order: number;
  w: number;
  h: number;
  /** 円で扱う（検証用。同じ大きさの円で 60 度になるかを見る） */
  circle?: boolean;
};

export type Placed = { id: string; parent: string | null; depth: number; x: number; y: number; w: number; h: number; angle: number; circle?: boolean };

export type Metrics = {
  overlaps: number;
  crossings: number;
  edgeThroughNode: number;
  interleave: number;
  s: number;
  width: number;
  height: number;
  adjustments: number;
};

export type LayoutResult = { nodes: Placed[]; metrics: Metrics; arcIndex: number; valid: boolean; candidates: { arcIndex: number; valid: boolean; s: number; width: number; height: number }[] };

export type LayoutOptions = {
  gap?: number;
  radialGap?: number;
  view?: { w: number; h: number };
};

type Tree = {
  root: LNode;
  kids: Map<string, LNode[]>;
  depth: Map<string, number>;
  byId: Map<string, LNode>;
};

function buildTree(nodes: LNode[]): Tree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => !n.parent || !byId.has(n.parent));
  if (roots.length !== 1) throw new Error(`根がちょうど1つではない（${roots.length}）`);
  const kids = new Map<string, LNode[]>();
  for (const n of nodes) {
    if (!n.parent || !byId.has(n.parent)) continue;
    const l = kids.get(n.parent) ?? [];
    l.push(n);
    kids.set(n.parent, l);
  }
  for (const l of kids.values()) l.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const depth = new Map<string, number>();
  const walk = (n: LNode, d: number) => { depth.set(n.id, d); for (const k of kids.get(n.id) ?? []) walk(k, d + 1); };
  walk(roots[0], 0);
  return { root: roots[0], kids, depth, byId };
}

/** 箱が円周の接線方向に占める半分の長さ（角度 θ の位置で）。円なら半径 */
function tangentHalf(n: LNode, theta: number): number {
  if (n.circle) return n.w / 2;
  return Math.abs((n.w / 2) * Math.cos(theta)) + Math.abs((n.h / 2) * Math.sin(theta));
}
function radialHalf(n: LNode): number {
  return n.circle ? n.w / 2 : n.h / 2;
}

function place(t: Tree, arcLimit: number, gap: number, radialGap: number, pad: number[], extraR: number[]): Placed[] {
  const maxDepth = Math.max(...t.depth.values());
  // 1. 世代の半径。深さ g の箱の半分の高さの最大値から、前の世代との間を決める
  const halfH: number[] = Array(maxDepth + 1).fill(0);
  for (const n of t.byId.values()) {
    const d = t.depth.get(n.id)!;
    halfH[d] = Math.max(halfH[d], radialHalf(n));
  }
  const R: number[] = [0];
  for (let g = 1; g <= maxDepth; g++) {
    const base = R[g - 1] + halfH[g - 1] + halfH[g] + (g === 1 ? gap : radialGap);
    R[g] = base + (extraR[g] ?? 0);
  }
  // 2. 葉から必要な角度幅。自分の幅は、下向きの近くに置く前提で接線方向の長さから出す
  const own = (n: LNode, d: number, theta: number) => {
    const half = tangentHalf(n, theta) + gap / 2;
    return 2 * Math.asin(Math.min(1, half / R[d])) * (pad[d] ?? 1);
  };
  const need = new Map<string, number>();
  const needOf = (n: LNode, theta: number): number => {
    const d = t.depth.get(n.id)!;
    const ks = t.kids.get(n.id) ?? [];
    const kidSum = ks.reduce((s, k) => s + needOf(k, theta), 0);
    const v = Math.max(d === 0 ? 0 : own(n, d, theta), kidSum);
    need.set(n.id, v);
    return v;
  };
  // 角度の見積もりは2回行う。1回目は下向き（0 度）で、2回目は1回目の角度で接線の長さを測り直す
  const angle = new Map<string, number>();
  const assign = (n: LNode, center: number, first: boolean) => {
    angle.set(n.id, center);
    const ks = t.kids.get(n.id) ?? [];
    if (!ks.length) return;
    const total = ks.reduce((s, k) => s + (first ? needOf(k, 0) : need.get(k.id)!), 0);
    let a = center - total / 2;
    for (const k of ks) {
      const w = first ? needOf(k, 0) : need.get(k.id)!;
      assign(k, a + w / 2, first);
      a += w;
    }
  };
  assign(t.root, 0, true);
  // 2回目: 各ノードの1回目の角度で幅を測り直す
  const needAt = (n: LNode): number => {
    const d = t.depth.get(n.id)!;
    const ks = t.kids.get(n.id) ?? [];
    const kidSum = ks.reduce((s, k) => s + needAt(k), 0);
    const v = Math.max(d === 0 ? 0 : own(n, d, angle.get(n.id)!), kidSum);
    need.set(n.id, v);
    return v;
  };
  needAt(t.root);
  // 弧の上限を超える世代は、半径を広げて収める（角度は半径に反比例して縮む）
  const rootKidsTotal = (t.kids.get(t.root.id) ?? []).reduce((s, k) => s + need.get(k.id)!, 0);
  if (rootKidsTotal > arcLimit) {
    const f = rootKidsTotal / arcLimit;
    for (let g = 1; g <= maxDepth; g++) R[g] *= f;
    needAt(t.root);
  }
  assign(t.root, 0, false);
  // 4. 座標
  const out: Placed[] = [];
  for (const n of t.byId.values()) {
    const d = t.depth.get(n.id)!;
    const th = angle.get(n.id)!;
    out.push({ id: n.id, parent: n.parent && t.byId.has(n.parent) ? n.parent : null, depth: d, x: R[d] * Math.sin(th), y: R[d] * Math.cos(th), w: n.w, h: n.h, angle: th, circle: n.circle });
  }
  return out;
}

// ---------- 検査 ----------

const EPS = 0.5;

function rectOverlap(a: Placed, b: Placed): boolean {
  if (a.circle && b.circle) return Math.hypot(a.x - b.x, a.y - b.y) < a.w / 2 + b.w / 2 - EPS;
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - EPS && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - EPS;
}

function segCross(p1: Placed, p2: Placed, p3: Placed, p4: Placed): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y), d2 = d(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
  const d3 = d(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y), d4 = d(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** 線分が箱を通るか（Liang-Barsky）。箱は余白の半分だけ膨らませ、角をかすめる線も数える（どの親の子か読めなくなるため） */
function segHitsRect(a: Placed, b: Placed, r: Placed, margin: number): boolean {
  const hw = r.w / 2 + margin, hh = r.h / 2 + margin;
  const x0 = r.x - hw, x1 = r.x + hw, y0 = r.y - hh, y1 = r.y + hh;
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dy, a.y - y0) && clip(dy, y1 - a.y) && t0 < t1;
}

export function measure(nodes: Placed[], view = LAYOUT.view, margin = LAYOUT.gap / 2): Metrics {
  let overlaps = 0, crossings = 0, through = 0, interleave = 0;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (rectOverlap(nodes[i], nodes[j])) overlaps++;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = nodes.filter((n) => n.parent).map((n) => [byId.get(n.parent!)!, n] as const);
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const [a, b] = edges[i], [c, d] = edges[j];
    if (a === c || a === d || b === c || b === d) continue;
    if (segCross(a, b, c, d)) crossings++;
  }
  for (const [a, b] of edges) for (const n of nodes) {
    if (n === a || n === b) continue;
    if (segHitsRect(a, b, n, margin)) through++;
  }
  // 枝の混ざり: 同じ世代を角度順に並べたとき、同じ親の子がひと続きになっていない回数
  const depths = new Set(nodes.map((n) => n.depth));
  for (const g of depths) {
    if (g < 2) continue;
    const row = nodes.filter((n) => n.depth === g).sort((a, b) => a.angle - b.angle);
    const seen = new Set<string>();
    let prev: string | null = null;
    for (const n of row) {
      if (n.parent !== prev) { if (seen.has(n.parent!)) interleave++; seen.add(n.parent!); prev = n.parent; }
    }
  }
  const minX = Math.min(...nodes.map((n) => n.x - n.w / 2)), maxX = Math.max(...nodes.map((n) => n.x + n.w / 2));
  const minY = Math.min(...nodes.map((n) => n.y - n.h / 2)), maxY = Math.max(...nodes.map((n) => n.y + n.h / 2));
  const width = maxX - minX, height = maxY - minY;
  return { overlaps, crossings, edgeThroughNode: through, interleave, s: Math.max(width / view.w, height / view.h), width, height, adjustments: 0 };
}

/** 1つの候補（弧の上限）で、重なりが無くなるまで決まった順序で広げる */
function solve(t: Tree, arcLimit: number, gap: number, radialGap: number, view: { w: number; h: number }) {
  const maxDepth = Math.max(...t.depth.values());
  const pad = Array(maxDepth + 1).fill(1);
  const extraR = Array(maxDepth + 1).fill(0);
  let nodes = place(t, arcLimit, gap, radialGap, pad, extraR);
  let m = measure(nodes, view, gap / 2);
  let n = 0;
  while ((m.overlaps || m.crossings || m.edgeThroughNode) && n < LAYOUT.maxAdjust) {
    n++;
    // 重なっている箱の組の、深いほうの世代を直す。同じ世代なら角度の余白、違う世代なら外側の半径
    let fixed = false;
    outer: for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (!rectOverlap(a, b)) continue;
      const g = Math.max(a.depth, b.depth);
      if (a.depth === b.depth && pad[g] < 3) pad[g] *= LAYOUT.padStep;
      else extraR[g] += LAYOUT.radiusStep;
      fixed = true;
      break outer;
    }
    // 重なりは無いが線が箱を通るか交差するときは、いちばん外の世代の半径を広げる
    if (!fixed) extraR[maxDepth] += LAYOUT.radiusStep;
    nodes = place(t, arcLimit, gap, radialGap, pad, extraR);
    m = measure(nodes, view, gap / 2);
  }
  m.adjustments = n;
  return { nodes, m };
}

export function layoutFamily(input: LNode[], opt: LayoutOptions = {}): LayoutResult {
  const t = buildTree(input);
  const gap = opt.gap ?? LAYOUT.gap;
  const radialGap = opt.radialGap ?? LAYOUT.radialGap;
  const view = opt.view ?? LAYOUT.view;
  const cands = LAYOUT.arcLimits.map((a, i) => ({ i, ...solve(t, a, gap, radialGap, view) }));
  const ok = (c: (typeof cands)[number]) => !c.m.overlaps && !c.m.crossings && !c.m.edgeThroughNode && !c.m.interleave;
  const valid = cands.filter(ok);
  const pool = valid.length ? valid : cands;
  const best = pool.reduce((a, b) => (b.m.s < a.m.s ? b : a));
  return { nodes: best.nodes, metrics: best.m, arcIndex: best.i, valid: ok(best), candidates: cands.map((c) => ({ arcIndex: c.i, valid: ok(c), s: Number(c.m.s.toFixed(3)), width: c.m.width, height: c.m.height })) };
}
