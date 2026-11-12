import { describe, expect, test } from "bun:test";
import { deltaOf, mergeConv, KEEP_CONV } from "./conv";
import type { ConvItem } from "./model";

const item = (n: number): ConvItem => ({ role: "assistant", text: `t${n}`, n });

describe("mergeConv", () => {
  test("増えていなければ同じ配列を返す（描き直さない）", () => {
    const prev = [item(0), item(1)];
    expect(mergeConv(prev, { items: [], total: 2, reset: false })).toBe(prev);
  });
  test("増えた分を後ろに足し、上限を超えた分は前から捨てる", () => {
    const prev = Array.from({ length: KEEP_CONV }, (_, i) => item(i));
    const next = mergeConv(prev, { items: [item(KEEP_CONV)], total: KEEP_CONV + 1, reset: false });
    expect(next.length).toBe(KEEP_CONV);
    expect(next[0].n).toBe(1);
    expect(next[KEEP_CONV - 1].n).toBe(KEEP_CONV);
    // 前からある項目は同じもの（吹き出しの memo が効く）
    expect(next[0]).toBe(prev[1]);
  });
  test("reset なら置き換える", () => {
    const next = mergeConv([item(0)], { items: [item(5), item(6)], total: 7, reset: true });
    expect(next.map((x) => x.n)).toEqual([5, 6]);
  });
});

describe("deltaOf", () => {
  const all: ConvItem[] = Array.from({ length: 100 }, (_, i) => ({ role: "user", text: `u${i}` }));
  test("初めては最後の上限分を reset で", () => {
    const d = deltaOf(all, null);
    expect(d.reset).toBe(true);
    expect(d.items.length).toBe(KEEP_CONV);
    expect(d.items[0].n).toBe(100 - KEEP_CONV);
    expect(d.total).toBe(100);
  });
  test("持っている分のあとだけ", () => {
    expect(deltaOf(all, 100).items).toEqual([]);
    expect(deltaOf(all, 98).items.map((x) => x.n)).toEqual([98, 99]);
  });
});
