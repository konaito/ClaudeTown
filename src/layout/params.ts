// 家族の木の配置のパラメータ。配置計算（layout.ts）と描画（App.tsx）の両方がここを見る。
// 方針は docs/design/geometric-layout.md（決定論的な幾何の配置）。検証の条件は docs/design/physics-layout.md の 10。

export const LAYOUT = {
  /** 箱どうしの最小の余白（px） */
  gap: 10,
  /** 世代の間の半径方向の余白（px） */
  radialGap: 18,
  /** 親と子のカード（深さ 0、1）の箱の大きさ。DOM はこの大きさで描く */
  card: { w: 176, h: 96 },
  /** 子が1〜4人で孫がいない世帯の、カードどうしの最小の余白（px）。この世帯は固定の座標に置く（layout.ts の childSlots） */
  cardMargin: 8,
  /** 孫より下の小さい札。幅は名前の長さで決め、この範囲に収める */
  mini: { minW: 72, maxW: 116, h: 62, pad: 20 },
  /** 深さ 3 以降の札は、1段下がるごとにこの倍率で縮める（MIN まで） */
  deepScale: 0.86,
  deepScaleMin: 0.74,
  /** 兄弟を並べる弧の上限の候補（ラジアン）。小さいほど縦に深く、大きいほど横に広い。s が一番小さい候補を選ぶ */
  arcLimits: [Math.PI * 0.9, Math.PI * 1.2, Math.PI * 1.5, Math.PI * 1.9],
  /** 重なりが残ったときの調整。決まった順序で、角度の余白を広げ、それでも残れば半径を広げる */
  padStep: 1.12,
  radiusStep: 14,
  maxAdjust: 40,
  /** s の基準にする表示領域（右の会話欄を除いた左側）。窓の大きさが変わっても配置し直さないよう固定値にする */
  view: { w: 1000, h: 660 },
  /** 家族の枠の内側の余白 */
  framePad: 18,
  /** 世帯モジュール（淡い色の枠）の寸法。並べ方（pack.ts）はこの大きさで箱を置く */
  group: { padX: 18, padTop: 12, padBottom: 18, head: 34, border: 1.5, minW: 240, gap: 28 },
  /** 新しい座標へ移るアニメーションの時間（ms） */
  moveMs: 350,
};

/** 世帯モジュールの外寸（並べ方に渡す大きさ）。配置の幅と高さに、家族の枠の余白と世帯の枠の見出し・余白・線を足す。描くときもこの大きさにする */
export function groupSizeOf(m: { width: number; height: number }): { w: number; h: number } {
  const G = LAYOUT.group;
  const cw = m.width + LAYOUT.framePad * 2, ch = m.height + LAYOUT.framePad * 2;
  return { w: Math.ceil(Math.max(G.minW, cw + G.padX * 2 + G.border * 2)), h: Math.ceil(G.head + ch + G.padTop + G.padBottom + G.border * 2) };
}

/** 名前の幅の見積もり（11px の太字）。全角は 11px、半角は 6.8px で数える */
export function textWidth(s: string, fontPx = 11): number {
  let w = 0;
  for (const ch of s) w += /[\u0000-\u00ff]/.test(ch) ? fontPx * 0.62 : fontPx;
  return w;
}

/** 深さごとの箱の大きさ。描画もこの値を使う */
export function boxOf(depth: number, name: string): { w: number; h: number; scale: number } {
  if (depth <= 1) return { ...LAYOUT.card, scale: 1 };
  const m = LAYOUT.mini;
  const w = Math.min(m.maxW, Math.max(m.minW, textWidth(name) + m.pad));
  const scale = depth === 2 ? 1 : Math.max(LAYOUT.deepScaleMin, Math.pow(LAYOUT.deepScale, depth - 2));
  return { w: w * scale, h: m.h * scale, scale };
}
