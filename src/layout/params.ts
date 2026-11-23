// 家族の木の配置のパラメータ。配置計算（layout.ts）と描画（App.tsx）の両方がここを見る。
// 方針は docs/design/geometric-layout.md（決定論的な幾何の配置）。検証の条件は docs/design/physics-layout.md の 10。

export const LAYOUT = {
  /** 箱どうしの最小の余白（px） */
  gap: 10,
  /** 世代の間の半径方向の余白（px） */
  radialGap: 18,
  /** 親と子のカード（深さ 0、1）の箱の大きさ。DOM はこの大きさで描く */
  card: { w: 176, h: 96 },
  /** 子が1〜8人の世帯の、カードどうしの最小の余白（px）。この世帯の子は固定の座標に置く（layout.ts の childSlots） */
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
  /** 子1〜8人の固定の座標で、孫までの距離を広げる回数の上限。子の位置を動かさないので、弧の計算より多く広げる */
  gridMaxAdjust: 400,
  /** s の基準にする表示領域（右の会話欄を除いた左側）。窓の大きさが変わっても配置し直さないよう固定値にする */
  view: { w: 1000, h: 660 },
  /**
   * 世帯モジュール（淡い色の枠）の寸法。並べ方（pack.ts）はこの大きさで箱を置く。CSS には groupCssVars() で渡す。
   * 余白は 4px グリッドの 1 層だけ。pad は枠の線の内側から、見出し（上）、カードの箱（左右と下）までの距離で、見出しとカードの左端がそろう。
   * headGap は見出しとカードの間で、同じ階層の要素の間として pad と同じ値にする。
   * border は 1。1.5 だと Chromium が 1 に丸めて描き、枠の外寸の計算と 1px ずれた（agent-browser の DPR 2 で computed が 1px）。
   * gap は世帯どうしの間。pad（16）より広く、枠が別の塊に見える最小の 24 にした（旧 28 から 4 だけ詰める）。
   */
  group: { pad: 16, head: 24, headGap: 16, border: 1, minW: 240, gap: 24 },
  /** 新しい座標へ移るアニメーションの時間（ms） */
  moveMs: 350,
};

/** 世帯の枠の左端から、見出しとカードの箱（配置の外接の箱）の左端までの距離。同じ値にして左端をそろえる */
export function groupInsetOf(): { x: number; headY: number; cardsY: number } {
  const G = LAYOUT.group;
  return { x: G.border + G.pad, headY: G.border + G.pad, cardsY: G.border + G.pad + G.head + G.headGap };
}

/** 世帯モジュールの外寸（並べ方に渡す大きさ）。配置の幅と高さに、世帯の枠の線・余白・見出しを足す。描くときもこの大きさにする */
export function groupSizeOf(m: { width: number; height: number }): { w: number; h: number } {
  const G = LAYOUT.group;
  const i = groupInsetOf();
  return { w: Math.ceil(Math.max(G.minW, m.width + i.x * 2)), h: Math.ceil(i.cardsY + m.height + G.pad + G.border) };
}

/** 世帯の枠（.group）の CSS が読む変数。余白を CSS に数字で書かず、LAYOUT.group と同じ値を使う */
export function groupCssVars(): Record<string, string> {
  const G = LAYOUT.group;
  return { "--g-pad": `${G.pad}px`, "--g-head": `${G.head}px`, "--g-head-gap": `${G.headGap}px`, "--g-border": `${G.border}px` };
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
