import { describe, expect, test } from "bun:test";
import { doneKey, doneLog, headOf, sortDone, watchOnce, type Done } from "./bootDone";

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

describe("見張りの1周（#184）", () => {
  const live = (done: Done[], queued: unknown[] = []) => ({ startedAt: 1, queued, done });
  const run = async (st: Record<string, ReturnType<typeof live> | { startedAt: null; queued: unknown[]; done: Done[] } | null>, listed = (_: string) => true) => {
    const toasts: string[] = [];
    await watchOnce(async (id) => st[id] ?? null, (t) => toasts.push(t), listed);
    return toasts;
  };

  test("カードから預けてパネルを開かずに失敗したら、トーストを1回出し、開いたら入力欄に戻す", async () => {
    doneLog.watch("w1", "たろう");
    const st = { w1: live([bad("起動したらこれやって", 1000)], ["次の文"]) };
    const first = await run(st);
    expect(first.length).toBe(1);
    expect(first[0]).toContain("たろう に届かなかった");
    expect(first[0]).toContain("入力欄に戻る");
    expect(await run(st)).toEqual([]);
    expect(doneLog.watching().some(([id]) => id === "w1")).toBe(true);
    expect(doneLog.takeBack("w1")).toEqual(["起動したらこれやって"]);
  });

  test("預かった文が無くなったら見張りから外す。読めなければ外す", async () => {
    doneLog.watch("w2", "はなこ");
    doneLog.watch("w3", "じろう");
    await run({ w2: live([]), w3: null });
    expect(doneLog.watching().map(([id]) => id)).not.toContain("w2");
    expect(doneLog.watching().map(([id]) => id)).not.toContain("w3");
  });

  test("パネルが読んでいるセッションは飛ばし、閉じたら引き継ぐ", async () => {
    doneLog.watch("w4", "さぶろう");
    doneLog.own("w4");
    const st = { w4: live([bad("パネルの文", 2000)]) };
    expect(await run(st)).toEqual([]);
    doneLog.release("w4");
    expect((await run(st)).length).toBe(1);
  });

  test("端末が無くなった子は、入力欄に戻さず文を長めに出す", async () => {
    doneLog.watch("w5", "しろう");
    const toasts = await run({ w5: { startedAt: null, queued: [], done: [bad("消えた子に預けた長い文".repeat(3), 3000)] } });
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain("送れなかった文");
    expect(toasts[0]).not.toContain("入力欄に戻る");
    expect(doneLog.takeBack("w5")).toEqual([]);
  });

  test("一覧から消えた子も、入力欄に戻さない", async () => {
    doneLog.watch("w6", "ごろう");
    const toasts = await run({ w6: live([bad("一覧にいない", 4000)]) }, () => false);
    expect(toasts[0]).not.toContain("入力欄に戻る");
    expect(doneLog.takeBack("w6")).toEqual([]);
  });
});
