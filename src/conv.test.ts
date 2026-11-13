import { describe, expect, test } from "bun:test";
import { deltaOf, mergeConv, KEEP_CONV, elapsedText, liveSummary, sameLive, type Live } from "./conv";
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
  test("同じ差分が2回届いても足すのは1回", () => {
    const d = { items: [item(2)], total: 3, reset: false };
    const once = mergeConv([item(0), item(1)], d);
    expect(mergeConv(once, d)).toBe(once);
    expect(once.map((x) => x.n)).toEqual([0, 1, 2]);
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

describe("今の動き（#59）", () => {
  const base: Live = { tools: [], last: "result", last_at: "2026-11-13T07:00:00.000Z", turn_at: 1000 };
  test("道具が無ければ考え中で、最後の出来事から数える", () => {
    expect(liveSummary(base)).toEqual({ label: "考え中", heads: [], since: Date.parse("2026-11-13T07:00:00.000Z") });
  });
  test("考え中は、ターンの始まりより前からは数えない", () => {
    expect(liveSummary({ ...base, last: "text", last_at: 100, turn_at: 5000 }).since).toBe(5000);
  });
  test("道具が1つならその中身、複数なら種類ごとの件数と新しい順の頭", () => {
    const one = { ...base, tools: [{ id: "a", kind: "シェル", text: "コマンド: git status", at: 5 }] };
    expect(liveSummary(one)).toEqual({ label: "コマンド: git status", heads: [], since: 5 });
    const many = { ...base, tools: [
      { id: "a", kind: "シェル", text: "コマンド: a", at: 5 },
      { id: "b", kind: "ccn", text: "send_message: x", at: 6 },
      { id: "c", kind: "シェル", text: "コマンド: c", at: 7 },
      { id: "d", kind: "ccn", text: "send_message: y", at: 8 },
    ] };
    expect(liveSummary(many)).toEqual({ label: "シェル2件・ccn 2件を実行中", heads: ["send_message: y", "コマンド: c", "send_message: x"], since: 5 });
  });
  test("経過の書き方", () => {
    expect(elapsedText(-5)).toBe("0秒");
    expect(elapsedText(22_400)).toBe("22秒");
    expect(elapsedText(65_000)).toBe("1分5秒");
    expect(elapsedText(3_720_000)).toBe("1時間2分");
  });
  test("中身が同じなら同じとみなす", () => {
    expect(sameLive(base, { ...base })).toBe(true);
    expect(sameLive(base, { ...base, last: "tool" })).toBe(false);
    expect(sameLive(null, undefined)).toBe(true);
  });
});
