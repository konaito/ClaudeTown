import { describe, expect, test } from "bun:test";
import { createVisibility } from "./visible";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pollWhileVisible（#6）", () => {
  test("見えている間は始めにすぐ1回呼び、間隔ごとに呼ぶ", async () => {
    const v = createVisibility(true);
    let n = 0;
    const stop = v.poll(() => { n++; }, 20);
    expect(n).toBe(1);
    await wait(70);
    stop();
    expect(n).toBeGreaterThanOrEqual(3);
  });

  test("隠れている間は一度も呼ばず、見えたらすぐ1回呼ぶ", async () => {
    const v = createVisibility(false);
    let n = 0;
    const stop = v.poll(() => { n++; }, 20);
    await wait(60);
    expect(n).toBe(0);
    v.set(true);
    expect(n).toBe(1);
    stop();
  });

  test("隠れたら止まり、止めた後は見えても呼ばない", async () => {
    const v = createVisibility(true);
    let n = 0;
    const stop = v.poll(() => { n++; }, 20);
    v.set(false);
    const at = n;
    await wait(60);
    expect(n).toBe(at);
    stop();
    v.set(true);
    await wait(30);
    expect(n).toBe(at);
  });

  test("同じ状態を続けて受けても、間隔を2つ作らない", async () => {
    const v = createVisibility(false);
    let n = 0;
    const stop = v.poll(() => { n++; }, 1000);
    v.set(true);
    v.set(true);
    v.set(false);
    v.set(true);
    // 見えるようになった2回だけ、すぐ呼ぶ
    expect(n).toBe(2);
    stop();
  });
});

describe("shownAt（#6）", () => {
  test("隠れてから見えた時刻を覚える。初めから見えていれば 0", () => {
    const v = createVisibility(true);
    expect(v.shownAt()).toBe(0);
    v.set(false);
    const before = Date.now();
    v.set(true);
    expect(v.shownAt()).toBeGreaterThanOrEqual(before);
  });
});
