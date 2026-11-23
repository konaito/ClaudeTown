import { describe, expect, test } from "bun:test";
import { asStatus, canRun, checkedText, compareText, runText, shortSha, showDot, type UpdateStatus } from "./update";

const base: UpdateStatus = {
  repo: "/Users/x/Documents/family-computing", branch: "origin/main",
  current: { tag: "stable-20261123-2100", sha: "7d9635899d8590eaa3b73862d432bc64afb0d21a" }, currentError: null,
  remote: "abcdef0123456789abcdef0123456789abcdef01", compare: { kind: "ahead", n: 3 }, compareError: null,
  available: true, checkedAt: 1_000_000, checkError: null, checking: false, run: { state: "idle" },
};
const st = (o: Partial<UpdateStatus>): UpdateStatus => ({ ...base, ...o });

describe("更新の欄と歯車の点（#295）", () => {
  test("update_status の形でない返事は null にする（ブラウザ表示の仮の返事など）", () => {
    expect(asStatus(null)).toBeNull();
    expect(asStatus("ブラウザ表示")).toBeNull();
    expect(asStatus({ available: true })).toBeNull();
    expect(asStatus(base)).toBe(base);
  });

  test("点は更新があって走っていないときだけ", () => {
    expect(showDot(null)).toBe(false);
    expect(showDot(base)).toBe(true);
    expect(showDot(st({ available: false, compare: { kind: "same" } }))).toBe(false);
    expect(showDot(st({ run: { state: "running", startedAt: 1 } }))).toBe(false);
    // 前回が失敗でも、更新があれば点を出す
    expect(showDot(st({ run: { state: "finished", ok: false, code: 1, at: "", tail: [] } }))).toBe(true);
  });

  test("ボタンは更新があり、走っておらず、押した返事を待っていないときだけ押せる", () => {
    expect(canRun(base, false)).toBe(true);
    expect(canRun(base, true)).toBe(false);
    expect(canRun(st({ run: { state: "running", startedAt: 1 } }), false)).toBe(false);
    expect(canRun(st({ available: false, compare: { kind: "diverged" } }), false)).toBe(false);
    expect(canRun(null, false)).toBe(false);
  });

  test("比べた結果の文", () => {
    expect(compareText(base)).toBe("3 コミット新しい版がある");
    expect(compareText(st({ compare: { kind: "same" }, available: false }))).toBe("最新");
    expect(compareText(st({ compare: { kind: "diverged" }, available: false }))).toContain("子孫ではない");
    expect(compareText(st({ current: null, currentError: "current.ref を読めない: x" }))).toBe("current.ref を読めない: x");
    expect(compareText(st({ compare: null, compareError: "今の版のコミット 7d96358 がリポジトリに無い" }))).toContain("7d96358");
    expect(compareText(st({ compare: null }))).toBe("まだ比べていない");
  });

  test("確かめた時刻の文", () => {
    expect(checkedText(base, 1_000_000 + 30_000)).toBe("1分以内に確かめた");
    expect(checkedText(base, 1_000_000 + 5 * 60_000 + 1)).toBe("5分前に確かめた");
    expect(checkedText(st({ checking: true }), 0)).toBe("確かめている…");
    expect(checkedText(st({ checkError: "git fetch origin が 128 で終わった" }), 0)).toContain("確かめられなかった");
    expect(checkedText(st({ checkedAt: null }), 0)).toBe("まだ fetch していない");
  });

  test("走らせた更新の文", () => {
    expect(runText({ state: "idle" })).toBeNull();
    expect(runText({ state: "running", startedAt: 1 })?.bad).toBe(false);
    expect(runText({ state: "finished", ok: true, code: 0, at: "2026-11-23 21:00:00", tail: [] })).toEqual({ text: "前回の更新は済んだ（2026-11-23 21:00:00）", bad: false });
    expect(runText({ state: "finished", ok: false, code: 1, at: "", tail: ["x"] })).toEqual({ text: "前回の更新は失敗した。終了コード 1", bad: true });
    expect(runText({ state: "finished", ok: false, code: null, at: "", tail: [] })?.text).toContain("終了コード なし");
  });

  test("sha は7字", () => {
    expect(shortSha(base.current!.sha)).toBe("7d96358");
    expect(shortSha(null)).toBe("—");
  });
});
