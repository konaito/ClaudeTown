import { describe, expect, test } from "bun:test";
import { createOffscreenWatcher, OFFSCREEN_ATTR } from "./offscreen";

type Cb = (entries: { target: unknown; isIntersecting: boolean }[]) => void;
function fake() {
  const made: { cb: Cb; init?: { rootMargin?: string }; watched: Set<unknown> }[] = [];
  class IO {
    watched = new Set<unknown>();
    cb: Cb;
    constructor(cb: Cb, init?: { rootMargin?: string }) { this.cb = cb; made.push({ cb, init, watched: this.watched }); }
    observe(el: unknown) { this.watched.add(el); }
    unobserve(el: unknown) { this.watched.delete(el); }
  }
  return { IO, made };
}
const el = () => {
  const attrs = new Set<string>();
  return { attrs, toggleAttribute(n: string, f?: boolean) { if (f ?? !attrs.has(n)) attrs.add(n); else attrs.delete(n); return attrs.has(n); } };
};

describe("createOffscreenWatcher（#12）", () => {
  test("要素が何個あっても observer は1つで、最初の watch で作る", () => {
    const { IO, made } = fake();
    const w = createOffscreenWatcher(IO);
    expect(made.length).toBe(0);
    Array.from({ length: 50 }, el).forEach((e) => w.watch(e));
    expect(made.length).toBe(1);
    expect(made[0].watched.size).toBe(50);
  });

  test("見えなくなると data-offscreen を付け、見えたら外す", () => {
    const { IO, made } = fake();
    const w = createOffscreenWatcher(IO);
    const a = el(), b = el();
    w.watch(a); w.watch(b);
    made[0].cb([{ target: a, isIntersecting: false }, { target: b, isIntersecting: true }]);
    expect(a.attrs.has(OFFSCREEN_ATTR)).toBe(true);
    expect(b.attrs.has(OFFSCREEN_ATTR)).toBe(false);
    made[0].cb([{ target: a, isIntersecting: true }]);
    expect(a.attrs.has(OFFSCREEN_ATTR)).toBe(false);
  });

  test("止めると observer から外し、付いていた印も消す。2回止めても1回分", () => {
    const { IO, made } = fake();
    const w = createOffscreenWatcher(IO);
    const a = el();
    const off = w.watch(a);
    made[0].cb([{ target: a, isIntersecting: false }]);
    off(); off();
    expect(made[0].watched.size).toBe(0);
    expect(a.attrs.has(OFFSCREEN_ATTR)).toBe(false);
    expect(w.size()).toBe(0);
  });

  test("同じ要素を2回 watch したら、2回止めるまで外さない", () => {
    const { IO, made } = fake();
    const w = createOffscreenWatcher(IO);
    const a = el();
    const o1 = w.watch(a), o2 = w.watch(a);
    expect(made[0].watched.size).toBe(1);
    o1();
    expect(made[0].watched.size).toBe(1);
    o2();
    expect(made[0].watched.size).toBe(0);
  });

  test("rootMargin を渡す。IntersectionObserver が無い環境では何もしない", () => {
    const { IO, made } = fake();
    createOffscreenWatcher(IO, "10px").watch(el());
    expect(made[0].init?.rootMargin).toBe("10px");
    const none = createOffscreenWatcher(undefined);
    expect(() => none.watch(el())()).not.toThrow();
  });
});
