// 家族の木の配置（決定論的な幾何）。DOM に触れず、同じ入力から同じ座標を返す。乱数と時刻は使わない。
//
// 1. 世代ごとの半径 R[g] を、箱の高さと余白から決める（中心は家族の一番上の親）
// 2. 葉から順に、各枝が必要とする角度幅を計算する（自分の箱の幅 2·arcsin(r/R) と、子の枝の合計の大きいほう）
// 3. 根の子は下向き（0 度）を中心に、孫より下は親の角度を中心に、必要な幅だけ空けて並べる
// 4. 角度と半径から座標を出す（下向きが 0 度、右が正。x = R·sinθ、y = R·cosθ）
// 5. 実際の矩形で重なりを検査し、残れば決まった順序で角度の余白、次に半径を広げてやり直す
// 6. 兄弟を並べる弧の上限を変えた候補を作り、検査を通るもののうち s が一番小さいものを選ぶ。
//    前に選んだ候補は引き継がない。同じ顔ぶれなら、どの町で、どの順で増えても同じ配置になる（docs/design/geometric-layout.md の末尾）
// ただし、子が1〜6人の世帯（根と子がカードの大きさ）は、上の計算をせず childSlots の固定の座標に子を置く。
// 孫がいても子の位置は変えず、孫より下をその子の、親から離れる向きの延長に並べる（placeGrid）。
// 検査を通らなければ、子の位置はそのままで、違反した枝の孫までの距離を広げる。上の計算には戻さない。
// 子が7人以上の世帯は上の計算のまま（docs/design/geometric-layout.md の「子1〜4人の固定の座標」「子3人、5人、6人の格子と、孫がいる世帯」）

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

export type LayoutResult = {
  nodes: Placed[];
  metrics: Metrics;
  /** 選んだ弧の候補。-1 は固定の座標（子1〜6人）に置いたこと */
  arcIndex: number;
  valid: boolean;
  candidates: { arcIndex: number; valid: boolean; s: number; width: number; height: number }[];
};

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

// ---------- 子1〜6人の固定の座標 ----------

/**
 * 子5人と6人の格子で、親と下の段（上の段）の間の縦の距離。h+m（104）を下限にし、親から角の子への紐が、
 * 左右の子と真下の子の箱（検査では余白 gap/2 だけ膨らませる）をかすめない最小の値にする。カード 176×96 と gap 10 で 108。
 * 紐は親の中心 (0,0) から角 (side, dy) への線分。左右の子の箱の内側の縁 x = side-(w/2+g) で、紐の y が h/2+g 以上になる条件から出す。
 */
export function gridRowGap(card = LAYOUT.card, m = LAYOUT.cardMargin, gap = LAYOUT.gap): number {
  const side = card.w + m, g = gap / 2;
  return Math.max(card.h + m, Math.ceil(((card.h / 2 + g) * side) / (side - card.w / 2 - g)));
}

/**
 * 親1人と子1〜6人の世帯で、子のカードを置く位置。親の中心が (0,0)、y は下が正。
 * 1、2、4人は本人が決めた座標（2026-11-13）。重ならない、余白 m を空ける、左右対称、紐を短く、外接矩形を小さく、の順に優先し、
 * 中心の間の距離をそろえることより詰めることを取る。
 * 3人、5人、6人は本人が決めた格子（2026-11-21）。左右の子は親と同じ高さに置き、上下の段は左右の列（x = ±side）と真ん中（x = 0）にそろえる。
 *   3人: 左、右、真下。5人: 左、右、左下、真下、右下。6人: 左上、右上、左、右、左下、右下。
 *   3人は角に子がいないので、段の間は 1、2、4人と同じ h+m にする。5人と6人は gridRowGap。
 * どの人数も、上の段から下の段へ、同じ段は左から右へ並べる。i 番目の子（兄弟の順は order、次に id）を i 番目の位置に置く。
 */
export function childSlots(count: number, card = LAYOUT.card, m = LAYOUT.cardMargin): { x: number; y: number }[] | null {
  const dx = (card.w + m) / 2, dy = card.h + m, side = card.w + m;
  const gy = gridRowGap(card, m);
  switch (count) {
    case 1: return [{ x: 0, y: dy }];
    case 2: return [{ x: -dx, y: dy }, { x: dx, y: dy }];
    case 3: return [{ x: -side, y: 0 }, { x: side, y: 0 }, { x: 0, y: dy }];
    case 4: return [{ x: -side, y: 0 }, { x: side, y: 0 }, { x: -dx, y: dy }, { x: dx, y: dy }];
    case 5: return [{ x: -side, y: 0 }, { x: side, y: 0 }, { x: -side, y: gy }, { x: 0, y: gy }, { x: side, y: gy }];
    case 6: return [{ x: -side, y: -gy }, { x: side, y: -gy }, { x: -side, y: 0 }, { x: side, y: 0 }, { x: -side, y: gy }, { x: side, y: gy }];
    default: return null;
  }
}

/** 根と根の子がすべてカードの大きさか。固定の座標はカードの大きさで決めてあるので、それ以外は今の計算に回す */
function kidsAreCards(t: Tree): boolean {
  const ks = t.kids.get(t.root.id) ?? [];
  return [t.root, ...ks].every((n) => !n.circle && n.w === LAYOUT.card.w && n.h === LAYOUT.card.h);
}

function placedRoot(t: Tree): Placed {
  return { id: t.root.id, parent: null, depth: 0, x: 0, y: 0, w: t.root.w, h: t.root.h, angle: 0 };
}

/** 箱が、根から角度 θ の向きに占める半分の長さ（箱の支持関数）。左右の子なら w/2、真下なら h/2 */
function radialHalfAt(n: LNode, theta: number): number {
  return Math.abs((n.w / 2) * Math.sin(theta)) + Math.abs((n.h / 2) * Math.cos(theta));
}

/**
 * 子1〜6人の世帯。子を childSlots の位置に置き、孫より下は今の計算と同じ決まりで、その子の外側（親から離れる向きの延長）に並べる。
 * 孫がいなければ、子の位置をそのまま返す。
 * - 子 k の枝の世代 d の半径 R_k[d] は、根から子 k までの距離から始め、子 k の角度の向きで箱の半分の長さと radialGap を足していく
 * - 兄弟は、子 k の角度（孫より下は親の角度）を中心に、重ならない最小の角度 2·arcsin(r/R) で並べる。葉から必要な幅を足し上げる
 * - extra[k] は子 k の枝の孫の半径に足す。検査に通らないときに広げる
 */
function placeGrid(t: Tree, slots: { x: number; y: number }[], gap: number, radialGap: number, extra: number[]): Placed[] {
  const ks = t.kids.get(t.root.id) ?? [];
  const out: Placed[] = [placedRoot(t)];
  ks.forEach((k, i) => {
    const th = Math.atan2(slots[i].x, slots[i].y);
    out.push({ id: k.id, parent: t.root.id, depth: 1, x: slots[i].x, y: slots[i].y, w: k.w, h: k.h, angle: th });
    // 枝の世代ごとの、向き θ での箱の半分の長さの最大
    const half: number[] = [];
    const walkH = (n: LNode, d: number) => { half[d] = Math.max(half[d] ?? 0, radialHalfAt(n, th)); for (const c of t.kids.get(n.id) ?? []) walkH(c, d + 1); };
    walkH(k, 1);
    const R: number[] = [];
    R[1] = Math.hypot(slots[i].x, slots[i].y);
    for (let d = 2; d < half.length; d++) R[d] = R[d - 1] + half[d - 1] + half[d] + radialGap + (d === 2 ? extra[i] : 0);
    const need = new Map<string, number>();
    const needOf = (n: LNode, d: number): number => {
      const own = 2 * Math.asin(Math.min(1, (tangentHalf(n, th) + gap / 2) / R[d]));
      const sum = (t.kids.get(n.id) ?? []).reduce((s, c) => s + needOf(c, d + 1), 0);
      const v = Math.max(own, sum);
      need.set(n.id, v);
      return v;
    };
    const assign = (n: LNode, d: number, center: number) => {
      const cs = t.kids.get(n.id) ?? [];
      const total = cs.reduce((s, c) => s + need.get(c.id)!, 0);
      let a = center - total / 2;
      for (const c of cs) {
        const w = need.get(c.id)!;
        const ang = a + w / 2;
        out.push({ id: c.id, parent: n.id, depth: d + 1, x: R[d + 1] * Math.sin(ang), y: R[d + 1] * Math.cos(ang), w: c.w, h: c.h, angle: ang });
        assign(c, d + 1, ang);
        a += w;
      }
    };
    for (const c of t.kids.get(k.id) ?? []) needOf(c, 2);
    assign(k, 1, th);
  });
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

const passes = (m: Metrics) => !m.overlaps && !m.crossings && !m.edgeThroughNode && !m.interleave;

/**
 * 子1〜6人の世帯を childSlots の位置に置く。子の位置は動かさず、検査に通るまで、違反した枝の孫までの距離を radiusStep ずつ広げる。
 * 重なった組は、深いほうの箱の枝（同じ深さなら両方の枝）を広げる。重なりが無く線の検査だけが残るときは、孫のいる枝をすべて広げる。
 * 孫までの距離を広げるほど、兄弟を並べる角度が狭まり、枝どうしが離れるので、いずれ通る。
 * gridMaxAdjust 回で通らなければ、最後の結果を valid: false で返す（画面は「配置が重なっている」を出す）。
 */
function solveGrid(t: Tree, slots: { x: number; y: number }[], gap: number, radialGap: number, view: { w: number; h: number }) {
  const ks = t.kids.get(t.root.id) ?? [];
  const branch = new Map<string, number>();
  ks.forEach((k, i) => { const walk = (n: LNode) => { branch.set(n.id, i); for (const c of t.kids.get(n.id) ?? []) walk(c); }; walk(k); });
  const extra: number[] = Array(ks.length).fill(0);
  let nodes = placeGrid(t, slots, gap, radialGap, extra);
  let m = measure(nodes, view, gap / 2);
  let n = 0;
  while (!passes(m) && n < LAYOUT.gridMaxAdjust) {
    n++;
    const grow = new Set<number>();
    outer: for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (!rectOverlap(a, b)) continue;
      for (const x of [a, b]) if (x.depth >= 2 && x.depth === Math.max(a.depth, b.depth)) grow.add(branch.get(x.id)!);
      break outer;
    }
    if (!grow.size) ks.forEach((k, i) => { if (t.kids.get(k.id)?.length) grow.add(i); });
    for (const i of grow) extra[i] += LAYOUT.radiusStep;
    nodes = placeGrid(t, slots, gap, radialGap, extra);
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
  // 余白を指定された呼び出し（検証用）は今の計算に回す
  const kidCount = t.kids.get(t.root.id)?.length ?? 0;
  const slots = opt.gap === undefined && opt.radialGap === undefined && kidsAreCards(t) ? childSlots(kidCount) : null;
  if (slots) {
    // 指標は今の計算と同じ measure で出す。世帯の枠（groupSizeOf）は width と height から決まるので、枠の計算も同じ式になる
    const g = solveGrid(t, slots, gap, radialGap, view);
    if (!passes(g.m)) console.warn("Claude Town: 子の固定の座標で、孫までの距離を広げても検査を通らなかった", t.root.id, g.m);
    // arcIndex -1 は「弧の候補を使わず固定の座標に置いた」。候補は作らない
    return { nodes: g.nodes, metrics: g.m, arcIndex: -1, valid: passes(g.m), candidates: [] };
  }
  const cands = LAYOUT.arcLimits.map((a, i) => ({ i, ...solve(t, a, gap, radialGap, view) }));
  const ok = (c: (typeof cands)[number]) => passes(c.m);
  const valid = cands.filter(ok);
  const pool = valid.length ? valid : cands;
  const best = pool.reduce((a, b) => (b.m.s < a.m.s ? b : a));
  return {
    nodes: best.nodes, metrics: best.m, arcIndex: best.i, valid: ok(best),
    candidates: cands.map((c) => ({ arcIndex: c.i, valid: ok(c), s: Number(c.m.s.toFixed(3)), width: c.m.width, height: c.m.height })),
  };
}
