// 世帯の枠の余白の検証（ui-consistency: 4px グリッド、同じ階層は同じ余白、左端をそろえる）。
// 実行: bun test src/layout/params.test.ts
import { describe, expect, test } from "bun:test";
import { LAYOUT, groupCssVars, groupInsetOf, groupSizeOf } from "./params";

describe("世帯の枠の余白", () => {
  const G = LAYOUT.group;
  test("枠の内側の余白と世帯どうしの間は 4px グリッドに乗る。世帯の間は 24 か 32", () => {
    for (const v of [G.pad, G.head, G.headGap, G.gap]) expect(v % 4).toBe(0);
    expect([24, 32]).toContain(G.gap);
    expect("framePad" in LAYOUT).toBe(false);
  });
  test("見出しの左端と、一番左のカードの箱の左端が、枠の左端から同じ距離にある", () => {
    const i = groupInsetOf();
    expect(i.x).toBe(G.border + G.pad);
    expect(i.x).toBe(G.border + G.pad); // 見出し（.g-head）は padding の内側の左端から始まる
  });
  test("上・左右・下・見出しとカードの間が同じ 1 つの値", () => {
    expect(new Set([G.pad, G.headGap]).size).toBe(1);
    const i = groupInsetOf();
    expect(i.headY).toBe(G.border + G.pad);
    expect(i.cardsY - i.headY - G.head).toBe(G.pad);
  });
  test("枠の外寸 = 配置の外接の箱 + 左右・上下の余白 + 見出し + 線。下の余白は左右と同じ", () => {
    const m = { width: 400, height: 200 };
    const s = groupSizeOf(m);
    expect(s.w).toBe(Math.ceil(400 + 2 * (G.border + G.pad)));
    expect(s.h).toBe(Math.ceil(2 * G.border + 2 * G.pad + G.head + G.headGap + 200));
    // 狭い世帯も広げない（最小の幅は持たない、#302）
    expect(groupSizeOf({ width: 100, height: 96 }).w).toBe(100 + 2 * (G.border + G.pad));
    expect("minW" in G).toBe(false);
  });
  test("枠の左右の余白が同じ。カード1枚（176）の世帯も、枠を中身に合わせて右に余りを残さない（#302）", () => {
    const i = groupInsetOf();
    for (const width of [LAYOUT.card.w, 2 * LAYOUT.card.w + 8, 400, 552]) {
      const s = groupSizeOf({ width, height: LAYOUT.card.h });
      const left = i.x, right = s.w - i.x - width;
      expect(right).toBe(left);
    }
    expect(groupSizeOf({ width: LAYOUT.card.w, height: LAYOUT.card.h }).w).toBe(LAYOUT.card.w + 2 * (G.border + G.pad));
  });
  test("CSS に渡す変数が LAYOUT.group と同じ値", () => {
    expect(groupCssVars()).toEqual({ "--g-pad": "16px", "--g-head": "24px", "--g-head-gap": "16px", "--g-border": "1px" });
  });
});
