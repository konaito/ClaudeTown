import { describe, expect, test } from "bun:test";
import { doneKey, doneLog, headOf, sortDone, type Done } from "./bootDone";

const ok = (text: string, doneAt: number, at = doneAt - 10): Done => ({ text, at, doneAt, error: null });
const bad = (text: string, doneAt: number, at = doneAt - 10): Done => ({ text, at, doneAt, error: "送れなかった: 端末が無い" });

describe("送り終えた文の扱い（#184）", () => {
  test("開いた時点にあった error 付きの done も、まだ知らせていなければ知らせる", () => {
    const r = sortDone("s1", [bad("やって", 100)], null, new Set());
    expect(r.failed.map((d) => d.text)).toEqual(["やって"]);
  });

  test("知らせ済みの失敗は、開き直しても知らせない", () => {
    const d = bad("やって", 100);
    const r = sortDone("s1", [d], null, new Set([doneKey("s1", d)]));
    expect(r.failed).toEqual([]);
  });

  test("開いた時点にあった届いた分は扱わない（仮の吹き出しを二重に出さない）", () => {
    const r = sortDone("s1", [ok("前の文", 100)], null, new Set());
    expect(r.delivered).toEqual([]);
  });

  test("開いた後に届いた分は1回だけ扱う", () => {
    const first = sortDone("s1", [ok("前の文", 100)], null, new Set());
    const second = sortDone("s1", [ok("前の文", 100), ok("次の文", 200)], first.handled, new Set());
    expect(second.delivered.map((d) => d.text)).toEqual(["次の文"]);
    const third = sortDone("s1", [ok("前の文", 100), ok("次の文", 200)], second.handled, new Set());
    expect(third.delivered).toEqual([]);
  });

  test("同じ文を2回預けて同じ瞬間に送れなくなっても、2件として知らせる", () => {
    const r = sortDone("s1", [bad("はい", 500, 100), bad("はい", 500, 200)], null, new Set());
    expect(r.failed.length).toBe(2);
  });

  test("キーはセッションで分ける", () => {
    const d = bad("やって", 100);
    const r = sortDone("s2", [d], null, new Set([doneKey("s1", d)]));
    expect(r.failed.length).toBe(1);
  });
});

describe("預けた文の見張りの台帳（#184）", () => {
  test("パネルか見張りの片方が知らせたら、もう片方は知らせない", () => {
    const d = bad("台帳の文", 900);
    const panel = sortDone("t1", [d], null, doneLog.reported);
    expect(panel.failed.length).toBe(1);
    doneLog.claim("t1", panel.failed);
    expect(sortDone("t1", [d], null, doneLog.reported).failed).toEqual([]);
  });
  test("見張りが知らせた文は、開いたときに1回だけ戻す", () => {
    doneLog.giveBack("t2", "一つ目");
    doneLog.giveBack("t2", "二つ目");
    expect(doneLog.takeBack("t2")).toEqual(["一つ目", "二つ目"]);
    expect(doneLog.takeBack("t2")).toEqual([]);
  });
  test("トーストには文の頭を1行で出す", () => {
    expect(headOf("a\n b")).toBe("a b");
    expect(headOf("x".repeat(40))).toBe(`${"x".repeat(30)}…`);
  });
});
