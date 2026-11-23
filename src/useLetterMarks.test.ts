import { describe, expect, test } from "bun:test";
import type { Flight } from "./letters";
import { SEEN_MAX, freshFlights } from "./useLetterMarks";

describe("新しく飛ばす封筒（#177）", () => {
  const fl = (id: string, at = 0): Flight => ({ id, from: "a", to: "b", at, summary: "", readAt: null });
  const ten = Array.from({ length: 10 }, (_, i) => fl(`r${i}`, i));

  test("一覧が届く前の描画（flights が []）では決めず、最初に届いた一覧の封筒は飛ばさない", () => {
    let s = freshFlights(null, [], false);
    expect(s.fresh).toHaveLength(0);
    s = freshFlights(s.seen, ten, true);
    expect(s.fresh).toHaveLength(0);
    // その後に足した1件だけが新しい
    s = freshFlights(s.seen, [...ten, fl("new", 10)], true);
    expect(s.fresh.map((f) => f.id)).toEqual(["new"]);
  });

  test("最初に届いた一覧が空なら、その後に来た封筒は飛ばす", () => {
    let s = freshFlights(null, [], false);
    s = freshFlights(s.seen, [], true);
    s = freshFlights(s.seen, [fl("a")], true);
    expect(s.fresh.map((f) => f.id)).toEqual(["a"]);
  });

  test("一覧の取得が一度欠けても（letters が空で来ても）、同じ封筒を二度飛ばさない", () => {
    let s = freshFlights(null, [], false);
    s = freshFlights(s.seen, ten, true);
    s = freshFlights(s.seen, [], true);
    s = freshFlights(s.seen, ten, true);
    expect(s.fresh).toHaveLength(0);
  });

  test("覚える数は SEEN_MAX 件までで、古い順に捨てる", () => {
    let s = freshFlights(null, [], false);
    s = freshFlights(s.seen, [], true);
    s = freshFlights(s.seen, Array.from({ length: SEEN_MAX + 5 }, (_, i) => fl(`x${i}`, i)), true);
    expect(s.seen?.size).toBe(SEEN_MAX);
    expect(s.seen?.has("x0")).toBe(false);
    expect(s.seen?.has(`x${SEEN_MAX + 4}`)).toBe(true);
  });
});
