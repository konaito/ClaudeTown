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

describe("pollBackoff（#5）", () => {
  test("変わらない回が続くと間隔が延び、変わったら戻る。kick ですぐ取り直す", async () => {
    const v = createVisibility(true);
    const at: number[] = [];
    let changed = false;
    const t0 = Date.now();
    const p = v.backoff(() => { at.push(Date.now() - t0); return changed; }, 30, 120);
    await wait(250);
    // 0, 60, 180 に呼ぶ（間隔が 60→120 と延びる。次は 300）
    expect(at.length).toBe(3);
    changed = true;
    p.kick();
    expect(at.length).toBe(4);
    await wait(75);
    // 変わったので 30 ごとに戻る
    expect(at.length).toBeGreaterThanOrEqual(5);
    p.stop();
  });

  test("間隔を関数で渡すと、毎回読み直す（作業中だけ縮める、#59）", async () => {
    const v = createVisibility(true);
    let n = 0;
    let fast = false;
    const p = v.backoff(() => { n++; return false; }, () => (fast ? 10 : 30), () => (fast ? 10 : 400));
    await wait(100);
    // 0, 60（延びて次は 120 後）
    expect(n).toBe(2);
    fast = true;
    p.kick();
    await wait(60);
    // 縮めたあとは延びずに 10 ごと
    expect(n).toBeGreaterThanOrEqual(6);
    p.stop();
  });

  test("隠れている間は呼ばない", async () => {
    const v = createVisibility(false);
    let n = 0;
    const p = v.backoff(() => { n++; return false; }, 10, 10);
    await wait(40);
    expect(n).toBe(0);
    v.set(true);
    expect(n).toBe(1);
    v.set(false);
    await wait(40);
    expect(n).toBe(1);
    p.stop();
  });
});
