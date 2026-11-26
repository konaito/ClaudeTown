// 家族の木の配置（決定論的な幾何）。DOM に触れず、同じ入力から同じ座標を返す。乱数と時刻は使わない。
//
// 1. 世代ごとの半径 R[g] を、箱の高さと余白から決める（中心は家族の一番上の親）
// 2. 葉から順に、各枝が必要とする角度幅を計算する（自分の箱の幅 2·arcsin(r/R) と、子の枝の合計の大きいほう）
// 3. 根の子は下向き（0 度）を中心に、孫より下は親の角度を中心に、必要な幅だけ空けて並べる
// 4. 角度と半径から座標を出す（下向きが 0 度、右が正。x = R·sinθ、y = R·cosθ）
// 5. 実際の矩形で重なりを検査し、残れば決まった順序で角度の余白、次に半径を広げてやり直す
// 6. 兄弟を並べる弧の上限を変えた候補を作り、検査を通るもののうち s が一番小さいものを選ぶ。
//    前に選んだ候補は引き継がない。同じ顔ぶれなら、どの町で、どの順で増えても同じ配置になる（docs/design/geometric-layout.md の末尾）
// ただし、子が1〜8人の世帯（根と子がカードの大きさ）は、上の計算をせず childSlots の固定の座標に子を置く。
// 孫がいても子の位置は変えない。孫より下は、親の周りの空いた所に詰めて置く候補（packGrid）と、
// 子の、親から離れる向きの延長に扇形に並べる候補（placeGrid、solveGrid）を作り、検査を通るもののうち世帯の枠の面積が一番小さいものを選ぶ（2026-11-26）。
// 扇形の候補は、検査を通らなければ、違反した枝の孫まで（ひ孫より下の線の違反なら、その世代まで）の距離を広げる。上の計算には戻さない。
// 子が9人以上の世帯は上の計算のまま（docs/design/geometric-layout.md の「子1〜4人の固定の座標」「子3人、5人、6人の格子と、孫がいる世帯」「子4人、7人、8人の格子」）

import { LAYOUT, groupSizeOf } from "./params";

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
  /** 選んだ弧の候補。-1 は固定の座標（子1〜8人）に置いたこと */
  arcIndex: number;
  valid: boolean;
  candidates: { arcIndex: number; valid: boolean; s: number; width: number; height: number }[];
  /** 子1〜8人の世帯で、孫より下に選んだ置き方。"bfs" と "dfs" は詰めて置いた、"fan" は子の外側に扇形に並べた */
  grid?: GridName;
  /** 子1〜8人の世帯で比べた置き方ごとの検査の結果と寸法 */
  gridCandidates?: { name: GridName; valid: boolean; width: number; height: number }[];
};

type GridName = "bfs" | "dfs" | "fan";
type GridCandidate = { name: GridName; nodes: Placed[]; m: Metrics };

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

// ---------- 子1〜8人の固定の座標 ----------

/**
 * 角に子がいる格子（子4人、5人、6人、7人、8人）で、親と下の段（上の段）の間の縦の距離。h+m（104）を下限にし、親から角の子への紐が、
 * 左右の子と真下の子の箱（検査では余白 gap/2 だけ膨らませる）をかすめない最小の値にする。カード 176×96 と gap 10 で 108。
 * 紐は親の中心 (0,0) から角 (side, dy) への線分。左右の子の箱の内側の縁 x = side-(w/2+g) で、紐の y が h/2+g 以上になる条件から出す。
 */
export function gridRowGap(card = LAYOUT.card, m = LAYOUT.cardMargin, gap = LAYOUT.gap): number {
  const side = card.w + m, g = gap / 2;
  return Math.max(card.h + m, Math.ceil(((card.h / 2 + g) * side) / (side - card.w / 2 - g)));
}

/**
 * 親1人と子1〜8人の世帯で、子のカードを置く位置。親の中心が (0,0)、y は下が正。
 * 1、2人は本人が決めた座標（2026-11-13）。重ならない、余白 m を空ける、左右対称、紐を短く、外接矩形を小さく、の順に優先し、
 * 中心の間の距離をそろえることより詰めることを取る。
 * 3〜8人は格子（3人、5人、6人は本人が 2026-11-21 に決めた。4人、7人、8人は同じ日に同じ流れで決めた）。
 * 左右の子は親と同じ高さに置き、上下の段は左右の列（x = ±side）と真ん中（x = 0）にそろえる。
 *   3人: 左、右、真下。4人: 左、右、左下、右下。5人: 左、右、左下、真下、右下。
 *   6人: 左上、右上、左、右、左下、右下。7人: 6人の下の段に真下を足す。8人: 7人の上の段に真上を足し、親の周りの8か所を埋める。
 *   3人は角に子がいないので、段の間は 1、2人と同じ h+m にする。4人から8人は gridRowGap。
 * どの人数も、上の段から下の段へ、同じ段は左から右へ並べる。i 番目の子（兄弟の順は order、次に id）を i 番目の位置に置く。
 */
export function childSlots(count: number, card = LAYOUT.card, m = LAYOUT.cardMargin): { x: number; y: number }[] | null {
  const dx = (card.w + m) / 2, dy = card.h + m, side = card.w + m;
  const gy = gridRowGap(card, m);
  switch (count) {
    case 1: return [{ x: 0, y: dy }];
    case 2: return [{ x: -dx, y: dy }, { x: dx, y: dy }];
    case 3: return [{ x: -side, y: 0 }, { x: side, y: 0 }, { x: 0, y: dy }];
    case 4: return [{ x: -side, y: 0 }, { x: side, y: 0 }, { x: -side, y: gy }, { x: side, y: gy }];
    case 5: return [{ x: -side, y: 0 }, { x: side, y: 0 }, { x: -side, y: gy }, { x: 0, y: gy }, { x: side, y: gy }];
    case 6: return [{ x: -side, y: -gy }, { x: side, y: -gy }, { x: -side, y: 0 }, { x: side, y: 0 }, { x: -side, y: gy }, { x: side, y: gy }];
    case 7: return [{ x: -side, y: -gy }, { x: side, y: -gy }, { x: -side, y: 0 }, { x: side, y: 0 }, { x: -side, y: gy }, { x: 0, y: gy }, { x: side, y: gy }];
    case 8: return [{ x: -side, y: -gy }, { x: 0, y: -gy }, { x: side, y: -gy }, { x: -side, y: 0 }, { x: side, y: 0 }, { x: -side, y: gy }, { x: 0, y: gy }, { x: side, y: gy }];
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
 * 子1〜8人の世帯。子を childSlots の位置に置き、孫より下は今の計算と同じ決まりで、その子の外側（親から離れる向きの延長）に並べる。
 * 孫がいなければ、子の位置をそのまま返す。
 * - 子 k の枝の世代 d の半径 R_k[d] は、根から子 k までの距離から始め、子 k の角度の向きで箱の半分の長さと radialGap を足していく
 * - 兄弟は、子 k の角度（孫より下は親の角度）を中心に、重ならない最小の角度 2·arcsin(r/R) で並べる。葉から必要な幅を足し上げる
 * - extra[k][d] は子 k の枝の世代 d の半径に足す（d は2以上）。検査に通らないときに広げる。d より外の世代も同じだけ外へ動く
 */
function placeGrid(t: Tree, slots: { x: number; y: number }[], gap: number, radialGap: number, extra: number[][]): Placed[] {
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
    for (let d = 2; d < half.length; d++) R[d] = R[d - 1] + half[d - 1] + half[d] + radialGap + (extra[i][d] ?? 0);
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

/** 角度 a を、基準 base から ±π の範囲に入れる。真上（π）の子の枝で、孫の角度が ±π をまたいで割れないようにする */
function unwrapAround(a: number, base: number): number {
  let d = a - base;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return base + d;
}

/** 詰めて置くときに比べる値の丸め。左右の鏡像の形が、浮動小数の差で別の位置に割れないようにする。負の数も絶対値で丸め、-0 は 0 にする */
const q2 = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 100)) / 100 || 0;

/** 世帯の枠が、外接矩形より幅と高さで大きい分（見出し、余白、線） */
const FRAME = groupSizeOf({ width: 0, height: 0 });

/** 詰めて置く途中の状態。置いた箱、紐、外接矩形 */
type PackState = { out: Placed[]; byId: Map<string, Placed>; edges: [Placed, Placed][]; minX: number; maxX: number; minY: number; maxY: number };

function packAdd(st: PackState, n: Placed) {
  st.out.push(n);
  st.byId.set(n.id, n);
  if (n.parent) st.edges.push([st.byId.get(n.parent)!, n]);
  st.minX = Math.min(st.minX, n.x - n.w / 2); st.maxX = Math.max(st.maxX, n.x + n.w / 2);
  st.minY = Math.min(st.minY, n.y - n.h / 2); st.maxY = Math.max(st.maxY, n.y + n.h / 2);
}

function packClone(st: PackState): PackState {
  return { out: [...st.out], byId: new Map(st.byId), edges: [...st.edges], minX: st.minX, maxX: st.maxX, minY: st.minY, maxY: st.maxY };
}

/** 世帯の枠（groupSizeOf）の面積。枠は外接矩形に見出しと余白を足した大きさ */
const packArea = (st: PackState) => q2((st.maxX - st.minX + FRAME.w) * (st.maxY - st.minY + FRAME.h));

/**
 * n を置けるか。measure と同じ判定で、置いた分だけを見る。
 * - ほかの箱と、縦か横に gap 以上離れる（measure の重なりは接していても通るので、置くときに余白を課す）
 * - 親からの紐が、ほかの箱（余白の半分だけ膨らませる）を通らない。既にある紐が、新しい箱を通らない
 * - 親からの紐が、既にある紐と交わらない。同じ世代を角度の順に並べたとき、枝が混ざらない
 */
function packFits(st: PackState, n: Placed, gap: number): boolean {
  const p = st.byId.get(n.parent!)!;
  const margin = gap / 2;
  if (st.out.some((b) => Math.abs(b.x - n.x) < (b.w + n.w) / 2 + gap - EPS && Math.abs(b.y - n.y) < (b.h + n.h) / 2 + gap - EPS)) return false;
  if (st.out.some((b) => b !== p && segHitsRect(p, n, b, margin))) return false;
  if (st.edges.some(([a, b]) => segHitsRect(a, b, n, margin))) return false;
  if (st.edges.some(([a, b]) => a !== p && b !== p && segCross(p, n, a, b))) return false;
  return !interleaves([...st.out.filter((x) => x.depth === n.depth), n]);
}

/**
 * c を置ける位置を、良い順に最大 limit 個返す。良さは、置いた後の世帯の枠の面積、s、兄弟の左右の偏り、親からの紐の長さ、鏡像の向き、座標の順で比べる。
 * 候補の座標は、親の近くの箱の縁に接する位置、縁をそろえる位置、親を中心に半分の幅ずつずらした位置の組み合わせから作る。
 * 親の近くで見つからなければ、範囲を広げてもう一度探す。
 */
function packCandidates(st: PackState, c: LNode, base: number, side: number, gap: number, limit: number, ring?: number): Placed[] {
  const p = st.byId.get(c.parent!)!;
  const depth = p.depth + 1;
  const found: Placed[] = [];
  let checked = 0;
  // 兄弟の左右の偏り（親の中心からの x の差の合計）。面積と s が同じなら、偏りが小さくなる位置を選び、左右対称に近づける
  const bal0 = st.out.reduce((a, x) => (x.parent === p.id ? a + x.x - p.x : a), 0);
  // ring を渡すと、親の中心から半径 ring の円の上を PACK_RING_STEP ずつ回った位置だけを候補にする
  for (const reach of ring === undefined ? [1.5, 3, 5] : [0]) {
    const pts: [number, number][] = [];
    if (ring !== undefined) {
      for (let j = 0; j * PACK_RING_STEP < 2 * Math.PI - 1e-9; j++) pts.push([q2(p.x + ring * Math.sin(j * PACK_RING_STEP)), q2(p.y + ring * Math.cos(j * PACK_RING_STEP))]);
    } else {
      const rx = p.w / 2 + reach * (c.w + gap), ry = p.h / 2 + reach * (c.h + gap);
      const near = st.out.filter((b) => Math.abs(b.x - p.x) <= rx + b.w / 2 && Math.abs(b.y - p.y) <= ry + b.h / 2);
      const xs = new Set<number>(), ys = new Set<number>();
      for (const b of near) {
        for (const v of [b.x, b.x - b.w / 2 - gap - c.w / 2, b.x + b.w / 2 + gap + c.w / 2, b.x - b.w / 2 + c.w / 2, b.x + b.w / 2 - c.w / 2]) if (Math.abs(v - p.x) <= rx) xs.add(q2(v));
        for (const v of [b.y, b.y - b.h / 2 - gap - c.h / 2, b.y + b.h / 2 + gap + c.h / 2, b.y - b.h / 2 + c.h / 2, b.y + b.h / 2 - c.h / 2]) if (Math.abs(v - p.y) <= ry) ys.add(q2(v));
      }
      for (let k = 1; k <= 2 * reach; k++) {
        xs.add(q2(p.x - (k * (c.w + gap)) / 2)); xs.add(q2(p.x + (k * (c.w + gap)) / 2));
        ys.add(q2(p.y - (k * (c.h + gap)) / 2)); ys.add(q2(p.y + (k * (c.h + gap)) / 2));
      }
      for (const x of xs) for (const y of ys) pts.push([x, y]);
    }
    const cands: { x: number; y: number; area: number; s: number; bal: number; len: number; turn?: number }[] = [];
    for (const [x, y] of pts) {
      // 親の箱に重なる位置は、検査の前に落とす
      if (Math.abs(x - p.x) < (p.w + c.w) / 2 + gap - EPS && Math.abs(y - p.y) < (p.h + c.h) / 2 + gap - EPS) continue;
      const w = Math.max(st.maxX, x + c.w / 2) - Math.min(st.minX, x - c.w / 2);
      const h = Math.max(st.maxY, y + c.h / 2) - Math.min(st.minY, y - c.h / 2);
      cands.push({ x, y, area: q2((w + FRAME.w) * (h + FRAME.h)), s: q2(Math.max(w / LAYOUT.view.w, h / LAYOUT.view.h) * 1000), bal: q2(Math.abs(bal0 + x - p.x)), len: q2(Math.hypot(x - p.x, y - p.y)) });
    }
    // 鏡像の向きは、面積、s、紐の長さが同じときだけ要るので、そのときに出す
    const turn = (k: (typeof cands)[number]) => (k.turn ??= q2((unwrapAround(Math.atan2(k.x, k.y), base) - base) * side));
    cands.sort((a, b) => a.area - b.area || a.s - b.s || a.bal - b.bal || a.len - b.len || turn(a) - turn(b) || a.x * side - b.x * side || a.y - b.y);
    for (const k of cands) {
      // 調べる数に上限を置く。良い順に並べてあるので、上限より後ろの位置は面積が大きく、選ばれても扇形の置き方に負けやすい
      if (++checked > PACK_MAX_CHECK) return found;
      const n: Placed = { id: c.id, parent: p.id, depth, x: k.x, y: k.y, w: c.w, h: c.h, angle: unwrapAround(Math.atan2(k.x, k.y), base) };
      if (!packFits(st, n, gap)) continue;
      found.push(n);
      if (found.length >= limit) return found;
    }
    if (found.length) return found;
  }
  return found;
}

/** 先読みで、兄弟の1人目の位置を試す数 */
const PACK_LOOKAHEAD = 3;
/** 1人の置き場所を探すときに検査する位置の数の上限。layoutOf は描画の中で同期に呼ばれるので、置けない枝で時間を使い切らない */
const PACK_MAX_CHECK = 200;
/** 兄弟を親の周りの円の上に並べるときの、角度の刻み（3度）と、試す半径の数 */
const PACK_RING_STEP = Math.PI / 60;
const PACK_RINGS = 10;

/**
 * 子1〜8人の世帯で、孫より下を、親の周りの空いた所に詰めて置く（2026-11-26、docs/design/geometric-layout.md の「孫を詰めて置く」）。
 * 子は slots の位置に置き、孫より下を、同じ親の兄弟ごとにまとめて置く。兄弟の置き方は次の2通りを試し、
 * 兄弟を置き終えたときの世帯の枠の面積（同じなら兄弟の左右の偏り、紐の長さの合計の順）が一番小さいものを選ぶ。
 * - 詰める: 1人ずつ、packCandidates の一番良い位置に置く。1人目だけは良い順に PACK_LOOKAHEAD 個の位置を試し、それぞれで残りを置いてみる。
 *   1人ずつ一番良い位置を選ぶと、1人目が親の真下を取り、2人目以降が横に広がることがあるためである。
 * - 円に並べる: 親の中心から同じ半径の円の上に、1人ずつ一番良い位置を選んで置く。半径は小さいほうから PACK_RINGS 通り試し、2つ置けたら止める。
 *   親のすぐ周りを埋めると、外側の孫への紐が内側の孫の箱を通って置けなくなる。同じ半径に並べれば、紐はほかの兄弟の箱を通りにくい。
 * 置ける位置は packFits で決める。
 * fanned に入れた枝（子の番号）は詰めずに、扇形の置き方 fan（solveGrid の結果）の座標に置き、ほかの枝をその周りに詰める。
 * どちらでも置けない兄弟があったら、その枝を fan の座標に置き換え、今の箱と紐に収まればそのまま続ける。
 * 収まらなければ、その枝の番号を failed で返す。呼ぶ側はその枝を fanned に足してやり直す。
 * order は "bfs"（孫の兄弟を全部置いてからひ孫の兄弟）か "dfs"（孫の兄弟を置くごとに、その下を続けて置く）。
 * 角度（angle）は、根から見た向きを、その枝の子の向きから ±π の範囲で表す。measure の枝の混ざりはこの角度の順で数える。
 */
function packGrid(t: Tree, slots: { x: number; y: number }[], gap: number, order: "bfs" | "dfs", fan: Placed[], fanned: Set<number>): { nodes: Placed[] } | { failed: number } {
  const ks = t.kids.get(t.root.id) ?? [];
  const r = placedRoot(t);
  let st: PackState = { out: [], byId: new Map(), edges: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  packAdd(st, r);
  const branchAngle = new Map<string, number>();
  const branchSide = new Map<string, number>();
  const branchOf = new Map<string, number>();
  ks.forEach((k, i) => {
    const th = Math.atan2(slots[i].x, slots[i].y);
    packAdd(st, { id: k.id, parent: t.root.id, depth: 1, x: slots[i].x, y: slots[i].y, w: k.w, h: k.h, angle: th });
    // 鏡像の向き: 左の列の子の枝は、右の列の子の枝を左右に裏返した選び方をする
    const side = slots[i].x < 0 ? -1 : 1;
    const walk = (n: LNode) => { branchAngle.set(n.id, th); branchSide.set(n.id, side); branchOf.set(n.id, i); for (const c of t.kids.get(n.id) ?? []) walk(c); };
    walk(k);
  });
  // 扇形に回した枝は、扇形の置き方（solveGrid）の座標をそのまま置く。親が先に入るよう、深さの順に足す
  for (const n of fan.filter((x) => x.depth >= 2 && fanned.has(branchOf.get(x.id)!)).sort((a, b) => a.depth - b.depth)) packAdd(st, n);
  const packed = ks.filter((_, i) => !fanned.has(i));
  // 兄弟をまとめて置く順。親の並び
  const parents: LNode[] = [];
  if (order === "bfs") {
    let level = packed;
    while (level.length) {
      const next: LNode[] = [];
      for (const n of level) { if (t.kids.get(n.id)?.length) parents.push(n); next.push(...(t.kids.get(n.id) ?? [])); }
      level = next;
    }
  } else {
    const walk = (n: LNode) => { const cs = t.kids.get(n.id) ?? []; if (cs.length) parents.push(n); for (const c of cs) walk(c); };
    for (const k of packed) walk(k);
  }
  const cand = (s: PackState, c: LNode, limit: number, ring?: number) => packCandidates(s, c, branchAngle.get(c.id)!, branchSide.get(c.id)!, gap, limit, ring);
  /** 兄弟を1人ずつ一番良い位置に置く。置けなければ null */
  const greedy = (s: PackState, sibs: LNode[], ring?: number) => {
    for (const c of sibs) { const n = cand(s, c, 1, ring)[0]; if (!n) return null; packAdd(s, n); }
    return s;
  };
  // 扇形の座標に置き換えた枝。残りの親の兄弟は置かない
  const done = new Set<number>();
  for (const parent of parents) {
    if (done.has(branchOf.get(parent.id)!)) continue;
    const sibs = t.kids.get(parent.id)!;
    const options: PackState[] = [];
    for (const first of cand(st, sibs[0], sibs.length > 1 ? PACK_LOOKAHEAD : 1)) {
      const trial = packClone(st);
      packAdd(trial, first);
      const done = greedy(trial, sibs.slice(1));
      if (done) options.push(done);
    }
    const p = st.byId.get(parent.id)!;
    const big = sibs.reduce((a, c) => Math.max(a, c.h), 0);
    let rings = 0;
    for (let k = 0; k < PACK_RINGS && rings < 2; k++) {
      const done = greedy(packClone(st), sibs, p.h / 2 + gap + big / 2 + (k * (big + gap)) / 2);
      if (done) { options.push(done); rings++; }
    }
    if (!options.length) {
      // この枝を扇形の座標に置き換えて続けられるか見る。置いた詰めの分を外し、扇形の座標が今の箱と紐に収まれば、やり直さずに続ける
      const i = branchOf.get(parent.id)!;
      const keep = st.out.filter((x) => x.depth < 2 || branchOf.get(x.id) !== i);
      const next: PackState = { out: [], byId: new Map(), edges: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const x of keep) packAdd(next, x);
      let ok = true;
      for (const x of fan.filter((y) => y.depth >= 2 && branchOf.get(y.id) === i).sort((a, b) => a.depth - b.depth)) {
        if (!packFits(next, x, gap)) { ok = false; break; }
        packAdd(next, x);
      }
      if (!ok) return { failed: i };
      st = next;
      done.add(i);
      continue;
    }
    const len = (s: PackState) => q2(sibs.reduce((a, c) => { const n = s.byId.get(c.id)!; return a + Math.hypot(n.x - p.x, n.y - p.y); }, 0));
    const bal = (s: PackState) => q2(Math.abs(sibs.reduce((a, c) => a + s.byId.get(c.id)!.x - p.x, 0)));
    const key = (s: PackState) => [packArea(s), bal(s), len(s)];
    st = options.reduce((a, b) => { const ka = key(a), kb = key(b); return kb[0] < ka[0] || (kb[0] === ka[0] && (kb[1] < ka[1] || (kb[1] === ka[1] && kb[2] < ka[2]))) ? b : a; });
  }
  return { nodes: st.out };
}

// ---------- 検査 ----------

/** 同じ世代の箱を角度の順に並べたとき、同じ親の子がひと続きになっていない回数（measure の枝の混ざり） */
function interleaves(row: Placed[]): number {
  const sorted = [...row].sort((a, b) => a.angle - b.angle);
  const seen = new Set<string>();
  let prev: string | null = null, n = 0;
  for (const x of sorted) {
    if (x.parent !== prev) { if (seen.has(x.parent!)) n++; seen.add(x.parent!); prev = x.parent; }
  }
  return n;
}

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
  // 線分の外接矩形が箱から離れていれば通らない（詰めて置くときに何度も呼ぶので、先に安く落とす）
  if (Math.max(a.x, b.x) < x0 || Math.min(a.x, b.x) > x1 || Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1) return false;
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
  for (const g of depths) if (g >= 2) interleave += interleaves(nodes.filter((n) => n.depth === g));
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

/** 交差した線と、箱を通る線の、子の側の箱。measure と同じ判定で数える */
function badEdgeKids(nodes: Placed[], margin: number): Placed[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = nodes.filter((n) => n.parent).map((n) => [byId.get(n.parent!)!, n] as const);
  const bad = new Set<Placed>();
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const [a, b] = edges[i], [c, d] = edges[j];
    if (a === c || a === d || b === c || b === d) continue;
    if (segCross(a, b, c, d)) { bad.add(b); bad.add(d); }
  }
  for (const [a, b] of edges) for (const n of nodes) {
    if (n === a || n === b) continue;
    if (segHitsRect(a, b, n, margin)) bad.add(b);
  }
  return [...bad];
}

const passes = (m: Metrics) => !m.overlaps && !m.crossings && !m.edgeThroughNode && !m.interleave;

/**
 * 子1〜8人の世帯を childSlots の位置に置く。子の位置は動かさず、検査に通るまで、違反した枝の孫までの距離を radiusStep ずつ広げる。
 * 重なった組は、深いほうの箱の枝（同じ深さなら両方の枝）を広げる。
 * 重なりが無く線の検査だけが残るときは、違反した線（交差した線、箱を通る線）の子の側が深さ3以上なら、その枝のその世代の半径だけを広げる。
 * 孫からひ孫への線は、孫までの距離を広げても形が変わらない（ひ孫の並びは孫と一緒に動く）ので、ひ孫までの距離を広げる（#214）。
 * 弧の計算の solve が一番外の世代（extraR[maxDepth]）を広げるのと同じ考え方である。
 * 違反した線の子の側が深さ2以下のときと、枝の混ざりが残るときは、前と同じく孫のいる枝をすべて、孫までの距離を広げる。
 * 孫までの距離を広げるほど、兄弟を並べる角度が狭まり、枝どうしが離れるので、いずれ通る。
 * gridMaxAdjust 回で通らなければ、最後の結果を valid: false で返す（画面は「配置が重なっている」を出す）。
 */
function solveGrid(t: Tree, slots: { x: number; y: number }[], gap: number, radialGap: number, view: { w: number; h: number }) {
  const ks = t.kids.get(t.root.id) ?? [];
  const branch = new Map<string, number>();
  ks.forEach((k, i) => { const walk = (n: LNode) => { branch.set(n.id, i); for (const c of t.kids.get(n.id) ?? []) walk(c); }; walk(k); });
  const extra: number[][] = ks.map(() => []);
  const grow = (i: number, d: number) => { extra[i][d] = (extra[i][d] ?? 0) + LAYOUT.radiusStep; };
  let nodes = placeGrid(t, slots, gap, radialGap, extra);
  let m = measure(nodes, view, gap / 2);
  let n = 0;
  while (!passes(m) && n < LAYOUT.gridMaxAdjust) {
    n++;
    // 枝の番号と深さの組を "i/d" で集め、1回に1度ずつ広げる
    const targets = new Set<string>();
    outer: for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (!rectOverlap(a, b)) continue;
      for (const x of [a, b]) if (x.depth >= 2 && x.depth === Math.max(a.depth, b.depth)) targets.add(`${branch.get(x.id)}/2`);
      break outer;
    }
    if (!targets.size) {
      // 重なりは無く線の検査だけが残る。違反した線の子が深さ3以上なら、その枝のその世代だけを広げる（弧の計算の extraR[maxDepth] と同じ考え方）。
      // 孫より上の線の違反と枝の混ざりは、前と同じく孫のいる枝の孫までの距離を広げる
      const bad = badEdgeKids(nodes, gap / 2);
      for (const c of bad) if (c.depth >= 3) targets.add(`${branch.get(c.id)}/${c.depth}`);
      if (!bad.length || bad.some((c) => c.depth < 3) || m.interleave) ks.forEach((k, i) => { if (t.kids.get(k.id)?.length) targets.add(`${i}/2`); });
    }
    for (const key of targets) { const [i, d] = key.split("/").map(Number); grow(i, d); }
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
    // 孫より下の置き方は3つの候補から選ぶ。詰めて置く2つ（孫から先に置く、枝ごとに置く）と、子の外側に扇形に並べる前の置き方（solveGrid）。
    // 検査を通る候補のうち、外接矩形の面積が一番小さいものを選ぶ。同じなら s、候補の順で決める。前の置き方も候補に残すので、前より大きくはならない
    const grid: GridCandidate[] = [];
    const f = solveGrid(t, slots, gap, radialGap, view);
    if (t.byId.size > kidCount + 1) {
      // ひ孫がいなければ、孫から先に置く順と枝ごとに置く順は同じなので、bfs だけを試す
      const orders = Math.max(...t.depth.values()) > 2 ? (["bfs", "dfs"] as const) : (["bfs"] as const);
      for (const order of orders) {
        // 詰め切れない枝は扇形に回してやり直す。全部の枝を扇形に回したら、扇形の候補と同じなので止める
        const fanned = new Set<number>();
        while (fanned.size < kidCount) {
          const r = packGrid(t, slots, gap, order, f.nodes, fanned);
          if ("nodes" in r) { grid.push({ name: order, nodes: r.nodes, m: measure(r.nodes, view, gap / 2) }); break; }
          fanned.add(r.failed);
        }
      }
    }
    grid.push({ name: "fan", nodes: f.nodes, m: f.m });
    const area = (m: Metrics) => { const g = groupSizeOf(m); return g.w * g.h; };
    const pool = grid.some((c) => passes(c.m)) ? grid.filter((c) => passes(c.m)) : grid.filter((c) => c.name === "fan");
    const g = pool.reduce((a, b) => (area(b.m) < area(a.m) || (area(b.m) === area(a.m) && b.m.s < a.m.s) ? b : a));
    if (!passes(g.m)) console.warn("Claude Town: 子の固定の座標で、孫までの距離を広げても検査を通らなかった", t.root.id, g.m);
    // arcIndex -1 は「弧の候補を使わず固定の座標に置いた」。弧の候補は作らない
    return {
      nodes: g.nodes, metrics: g.m, arcIndex: -1, valid: passes(g.m), candidates: [], grid: g.name,
      gridCandidates: grid.map((c) => ({ name: c.name, valid: passes(c.m), width: c.m.width, height: c.m.height })),
    };
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
