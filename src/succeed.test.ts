import { describe, expect, test } from "bun:test";
import { SUCCEED_POLL_MS, SUCCEED_RECHECKS, SUCCEED_RECHECK_MS, SUCCEED_WAIT_MS, SucceedError, ccnRefusal, clockText, handoffPrompt, kidsOf, refusalError, startSuccessor, succeedBlock, successorIn, type SucceedDeps } from "./succeed";
import type { Agent } from "./model";

const OLD = "1f3efa8b-b958-4e3f-bc51-d2cf09cb0eaa";
const NEW = "f7a05063-6d62-40d7-b13c-3604a655dfda";
const PARENT = "25e64ebd-0000-0000-0000-000000000001";
const ag = (over: Partial<Agent> = {}): Agent => ({
  id: OLD, name: "meta", kind: "terminal", state: "idle", cwd: "/w/meta", canSend: true, parent: null,
  capabilities: { send: true, stop: true, terminal: true }, ...over,
});

describe("引き継げるか", () => {
  test("手元の町の、待機中の、止められるセッションは引き継げる", () => expect(succeedBlock(ag(), true)).toBeNull());
  test("返事待ちや完了の印が付いていても、state が idle なら引き継げる", () => {
    expect(succeedBlock(ag({ report: { phase: "needs_you" } as Agent["report"] }), true)).toBeNull();
    expect(succeedBlock(ag({ closeCheck: { status: "ok" } }), true)).toBeNull();
  });
  test("作業中と承認待ちは引き継げない", () => {
    expect(succeedBlock(ag({ state: "running" }), true)).toContain("待機になってから");
    expect(succeedBlock(ag({ state: "waiting_permission" }), true)).toContain("待機になってから");
  });
  test("別の機械の町は引き継げない", () => expect(succeedBlock(ag(), false)).toContain("別の機械"));
  test("ccn から止められないセッションは引き継げない", () => {
    expect(succeedBlock(ag({ capabilities: { send: true, stop: false } }), true)).toContain("止められない");
    expect(succeedBlock(ag({ capabilities: null }), true)).toContain("止められない");
  });
  test("親が転出のゴーストなら引き継げない（ghost: の ID を親として渡さない）", () => {
    expect(succeedBlock(ag({ parent: `ghost:${PARENT}` }), true)).toContain("親が別の町");
  });
  test("ゴーストそのものは引き継げない", () => {
    expect(succeedBlock(ag({ id: `ghost:${OLD}`, capabilities: null, ghost: { town: "vm", realId: OLD, role: "child" } }), true)).toContain("その町で");
  });
});

describe("後継の1通目", () => {
  test("前任の名前と ID、上限で止まったこと、状態を確かめてから続けることが入る", () => {
    const p = handoffPrompt({ name: "meta", id: OLD, kids: [] });
    expect(p).toContain(`「meta」（${OLD}）`);
    expect(p).toContain("利用上限で止まった");
    expect(p).toContain("切れた前提");
    expect(p).toContain("git status");
    expect(p).not.toContain("read_messages");
  });
  test("生きた子がいれば、名前と ID と、知らせが届かないことが入る", () => {
    const p = handoffPrompt({ name: "meta", id: OLD, kids: [{ name: "claudetown", id: NEW }, { name: "ccn", id: PARENT, town: "vm" }] });
    expect(p).toContain(`「claudetown」（${NEW}）`);
    expect(p).toContain(`「ccn」（${PARENT}、vm にいる）`);
    expect(p).toContain("read_messages");
    // ccn が子を付け替えたときも、付け替えなかったときも正しい文にする（「届かない」と言い切らない）
    expect(p).toContain("付け替えていれば");
    expect(p).toContain("届かないとき");
    expect(p).not.toContain("このセッションには届かない");
  });
  test("転出のゴーストの子は、本物の ID と町の名前にする", () => {
    const kids = kidsOf([ag({ id: NEW, name: "a" }), ag({ id: `ghost:${PARENT}`, name: "b", ghost: { town: "vm", realId: PARENT, role: "child" } })]);
    expect(kids).toEqual([{ name: "a", id: NEW }, { name: "b", id: PARENT, town: "vm" }]);
  });
});

/** 偽の口。details は session_detail の応答を、ID ごとに呼ばれた順に返す（最後の1つは繰り返す） */
function fake(o: { details: Record<string, unknown[]>; created?: unknown; createError?: string; stopError?: string }) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const seen: Record<string, number> = {};
  let t = 0;
  const d: SucceedDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    call: (async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "session_detail") {
        const id = String(args.sessionId);
        const list = o.details[id] ?? [];
        const i = Math.min(seen[id] ?? 0, list.length - 1);
        seen[id] = (seen[id] ?? 0) + 1;
        const v = list[i];
        if (v instanceof Error) throw v;
        return v;
      }
      if (cmd === "create_session") { if (o.createError) throw new Error(o.createError); return o.created; }
      if (cmd === "stop_session") { if (o.stopError) throw new Error(o.stopError); return null; }
      throw new Error(`知らない命令: ${cmd}`);
    }) as SucceedDeps["call"],
  };
  return { d, calls, elapsed: () => t };
}
const size = { cols: 120, rows: 40 };

describe("後継を立てる（古い ccn。応答に succeeded が無い）", () => {
  test("根の後継は親なしで、前任の cwd と ID の付け直し（resume と fork）で立てる。succeed も付ける", async () => {
    const f = fake({
      details: { [OLD]: [{ state: "idle", depth: 0, title: "succeed-test-R" }], [NEW]: [{ state: "running", cursor: 0 }, { state: "running", cursor: 1 }] },
      created: { id: NEW, cwd: "/w/meta", depth: 0 },
    });
    const r = await startSuccessor({ agent: ag(), kids: [], ...size }, f.d);
    expect(r).toEqual({ kind: "took", id: NEW, cwd: "/w/meta", account: null, depth: 0, depthChecked: true });
    const create = f.calls.find((c) => c.cmd === "create_session")!.args;
    expect(create).toMatchObject({ cwd: "/w/meta", parent: null, resume: OLD, fork: true, succeed: true, peer: null, name: "succeed-test-R", cols: 120, rows: 40 });
    expect(String(create.prompt)).toContain(OLD);
    // 前任は止めない（止めるのは呼び手）
    expect(f.calls.some((c) => c.cmd === "stop_session")).toBe(false);
    expect(f.elapsed()).toBe(SUCCEED_POLL_MS * 2);
  });

  test("子の後継には、前任の親を渡す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 1 }], [NEW]: [{ state: "idle", cursor: 3 }] }, created: { id: NEW, cwd: "/w/kid", depth: 1 } });
    const r = await startSuccessor({ agent: ag({ parent: PARENT, cwd: "/w/kid" }), kids: [], ...size }, f.d);
    expect(r.kind).toBe("took");
    expect(f.calls.find((c) => c.cmd === "create_session")!.args).toMatchObject({ parent: PARENT, cwd: "/w/kid", name: null });
  });

  test("ccn の今の値が待機でなければ、作らずに投げる", async () => {
    const f = fake({ details: { [OLD]: [{ state: "running", depth: 0 }] }, created: { id: NEW, depth: 0 } });
    await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("待機になってから");
    expect(f.calls.some((c) => c.cmd === "create_session")).toBe(false);
  });

  test("前任がもう止まっていれば、作らずに投げる", async () => {
    const f = fake({ details: { [OLD]: [{ state: "exited", exitReason: "idle-stop: no activity for 10 min" }] }, created: { id: NEW, depth: 0 } });
    await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("もう止まっている");
    expect(f.calls.some((c) => c.cmd === "create_session")).toBe(false);
  });

  test("作れなければ投げる。前任には何もしない", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, createError: "ccn が 400 を返した: cwd does not exist" });
    await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("cwd does not exist");
    expect(f.calls.some((c) => c.cmd === "stop_session")).toBe(false);
  });

  test("応答の ID が無いか前任と同じなら投げる", async () => {
    for (const created of [null, {}, { id: OLD, depth: 0 }]) {
      const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, created });
      await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("ID を返さなかった");
    }
  });

  test("深さが前任と違えば、後継だけを止めて投げる", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 1 }] }, created: { id: NEW, depth: 0 } });
    await expect(startSuccessor({ agent: ag({ parent: PARENT }), kids: [], ...size }, f.d)).rejects.toThrow("後継は止めた");
    expect(f.calls.filter((c) => c.cmd === "stop_session").map((c) => c.args.sessionId)).toEqual([NEW]);
  });

  test("前任の深さが詳細に無ければ、比べずに進めて、比べていないと返す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle" }], [NEW]: [{ state: "running", cursor: 2 }] }, created: { id: NEW, depth: 1 } });
    const r = await startSuccessor({ agent: ag(), kids: [], ...size }, f.d);
    expect(r).toMatchObject({ kind: "took", depth: 1, depthChecked: false });
  });

  test("後継が落ちたら投げる（存在しない ID の付け直しは、作成の応答の後で落ちる）", async () => {
    const f = fake({
      details: { [OLD]: [{ state: "idle", depth: 0 }], [NEW]: [{ state: "running", cursor: 0 }, { state: "running", cursor: 0 }, { state: "exited", cursor: 0, exitReason: "exit 1" }] },
      created: { id: NEW, depth: 0 },
    });
    await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("後継が起動しなかった（exit 1）");
    expect(f.calls.some((c) => c.cmd === "stop_session")).toBe(false);
  });

  test("上限まで待っても1通目を受け取らなければ waiting を返す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }], [NEW]: [{ state: "running", cursor: 0 }] }, created: { id: NEW, depth: 0 } });
    const r = await startSuccessor({ agent: ag(), kids: [], ...size }, f.d);
    expect(r.kind).toBe("waiting");
    expect(f.elapsed()).toBe(SUCCEED_WAIT_MS);
  });

  test("様子を1回読めなくても、次の回で見る", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }], [NEW]: [new Error("ccn に届かない"), { state: "running", cursor: 1 }] }, created: { id: NEW, depth: 0 } });
    expect((await startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).kind).toBe("took");
  });
});

// 2026-11-17 に開発用ノード（ccn main e6c5f87）から取れた応答。アカウントの名前と email は仮のものに替えた
const KID = "3568b07a-3a5f-4542-8bc9-7973efa96aa2";
const CCN_OK = { id: NEW, cwd: "/w/meta", state: "running", kind: "pty", depth: 0, cursor: 0, parent: "local", account: "acct-a", accountEmail: "a@example.invalid", succeeded: { from: OLD, stopped: true, adopted: [KID] } };
const NO_ACCOUNT = `ccn が 409 を返した: {"error":"no account has quota left; the successor would stop the same way","code":"no_account","nextAvailable":{"account":"acct-a","at":1794927507000}}`;
const FAILED = `ccn が 502 を返した: {"error":"the successor did not start; the predecessor and its children were left as they were","code":"successor_failed","reason":"exit 1"}`;
const ALREADY = `ccn が 409 を返した: {"error":"session ${OLD} was already succeeded by ${NEW}","code":"already_succeeded","successor":"${NEW}"}`;
const SUCCEEDED_REASON = `succeeded: continued as ${NEW}`;

describe("後継を立てる（新しい ccn。応答に succeeded がある）", () => {
  test("ccn が引き継いだら、様子を見に行かず、前任も止めずに、結果をそのまま返す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, created: CCN_OK });
    const r = await startSuccessor({ agent: ag(), kids: [{ name: "kid", id: KID }], ...size }, f.d);
    expect(r).toEqual({ kind: "ccn", id: NEW, cwd: "/w/meta", account: "acct-a", stopped: true, note: undefined, adopted: [KID] });
    expect(f.calls.map((c) => c.cmd)).toEqual(["session_detail", "create_session"]);
    expect(f.elapsed()).toBe(0);
  });

  test("ccn が前任を止められなかったら、stopped: false と理由を返す（止めるのは呼び手）", async () => {
    const note = "the predecessor did not stop; stop it yourself so it does not continue in two places";
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, created: { ...CCN_OK, succeeded: { from: OLD, stopped: false, note, adopted: [] } } });
    const r = await startSuccessor({ agent: ag(), kids: [], ...size }, f.d);
    expect(r).toMatchObject({ kind: "ccn", stopped: false, note, adopted: [] });
    expect(f.calls.some((c) => c.cmd === "stop_session")).toBe(false);
  });

  test("深さが前任と違っても、後継を止めない（前任はもう止まっていて、戻せない）", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 1 }] }, created: CCN_OK });
    expect((await startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).kind).toBe("ccn");
    expect(f.calls.some((c) => c.cmd === "stop_session")).toBe(false);
  });

  test("枠の残るアカウントが無ければ、次に空く時刻を入れて投げる。前任は読み直さない", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, createError: NO_ACCOUNT });
    const e = await startSuccessor({ agent: ag(), kids: [], ...size }, f.d).catch((x) => x);
    expect(e).toBeInstanceOf(SucceedError);
    expect(e.kind).toBe("no_account");
    expect(e.nextAvailable).toEqual({ account: "acct-a", at: 1794927507000 });
    expect(e.message).toContain("後継を立てなかった");
    expect(e.message).toContain("（acct-a）");
    expect(f.calls.filter((c) => c.cmd === "session_detail")).toHaveLength(1);
  });

  test("後継が起動しなかったら、理由と、前任と子がそのままであることを出す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, createError: FAILED });
    await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("後継が起動しなかった（exit 1）。前任と子はそのまま");
  });

  test("同じ前任の2回目（二度押し、送り直し）は、済んでいた後継を返す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, createError: ALREADY });
    expect(await startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).toEqual({ kind: "ccn", id: NEW, cwd: "/w/meta", stopped: true, adopted: [], already: true });
  });

  test("押す前に引き継がれて止まっていたら、作らずに、済んでいた後継を返す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "exited", exitReason: SUCCEEDED_REASON }] }, created: CCN_OK });
    expect(await startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).toMatchObject({ kind: "ccn", id: NEW, already: true });
    expect(f.calls.some((c) => c.cmd === "create_session")).toBe(false);
  });

  test("応答を待ち切れなくても、前任が引き継がれて止まっていれば成功として返す", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }, { state: "exited", exitReason: SUCCEEDED_REASON }] }, createError: "ccn に届かない: timed out reading response" });
    expect(await startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).toEqual({ kind: "ccn", id: NEW, cwd: "/w/meta", stopped: true, adopted: [], already: false });
    expect(f.elapsed()).toBe(0);
  });

  test("応答を待ち切れず、ccn がまだ途中でも、少し待って読み直す", async () => {
    // 1回目の読み直しではまだ待機、2回目で引き継がれて止まっている
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }, { state: "idle", depth: 0 }, { state: "exited", exitReason: SUCCEEDED_REASON }] }, createError: "ccn に届かない: timed out reading response" });
    expect(await startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).toMatchObject({ kind: "ccn", id: NEW, already: false });
    expect(f.elapsed()).toBe(SUCCEED_RECHECK_MS);
  });

  test("応答を待ち切れず、読み直しても前任が待機のままなら、失敗の文をそのまま投げる", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, createError: "ccn に届かない: timed out reading response" });
    await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("timed out reading response");
    expect(f.calls.filter((c) => c.cmd === "session_detail")).toHaveLength(1 + SUCCEED_RECHECKS);
    expect(f.elapsed()).toBe(SUCCEED_RECHECK_MS * (SUCCEED_RECHECKS - 1));
  });

  test("ccn が code の無い断りを返したら、読み直さずにその文を投げる", async () => {
    const f = fake({ details: { [OLD]: [{ state: "idle", depth: 0 }] }, createError: `ccn が 400 を返した: {"error":"cwd is outside roots","roots":["/x"]}` });
    await expect(startSuccessor({ agent: ag(), kids: [], ...size }, f.d)).rejects.toThrow("ccn が断った（400）: cwd is outside roots");
    expect(f.calls.filter((c) => c.cmd === "session_detail")).toHaveLength(1);
  });
});

describe("ccn の断りを読む", () => {
  test("Rust の失敗の文から、状態と code と中身を取り出す", () => {
    expect(ccnRefusal(new Error(NO_ACCOUNT))).toMatchObject({ status: 409, code: "no_account", nextAvailable: { account: "acct-a", at: 1794927507000 } });
    expect(ccnRefusal(FAILED)).toMatchObject({ status: 502, code: "successor_failed", reason: "exit 1" });
    expect(ccnRefusal(ALREADY)).toMatchObject({ status: 409, code: "already_succeeded", successor: NEW });
  });
  test("JSON だけの文（ブラウザ表示のモック）も読む", () => {
    expect(ccnRefusal(new Error(`{"error":"x","code":"succeeding"}`))).toMatchObject({ status: undefined, code: "succeeding" });
  });
  test("次に空く時刻が無い断り（cam が答えなかった）は null", () => {
    expect(ccnRefusal(`ccn が 409 を返した: {"error":"x","code":"no_account","nextAvailable":null}`)?.nextAvailable).toBeNull();
  });
  test("ccn の断りでない失敗（届かない、時間切れ、JSON でない本文）は null", () => {
    expect(ccnRefusal(new Error("ccn に届かない: Connection refused"))).toBeNull();
    expect(ccnRefusal("ccn が 502 を返した: <html>Bad Gateway</html>")).toBeNull();
    expect(ccnRefusal("ccn が 400 を返した: {こわれた")).toBeNull();
  });
  test("引き継がれて止まった前任の理由から、後継の id を読む", () => {
    expect(successorIn(SUCCEEDED_REASON)).toBe(NEW);
    expect(successorIn("idle-stop: no activity for 10 min")).toBeNull();
    expect(successorIn(undefined)).toBeNull();
  });
});

describe("断りの文", () => {
  // 時刻は手元の時間帯で作る（試験を動かす機械の時間帯に依らないように）
  const now = new Date(2026, 10, 17, 23, 30).getTime();
  test("枠が無いときは、次に空く時刻とアカウントを出す。今日なら時刻だけ、明日なら日付も", () => {
    const today = refusalError({ code: "no_account", nextAvailable: { account: "acct-a", at: new Date(2026, 10, 17, 23, 55).getTime() } }, now);
    expect(today.message).toBe("枠の残るアカウントが無いので、後継を立てなかった。次に空くのは 23:55 ごろ（acct-a）。前任は止めていない");
    const tomorrow = refusalError({ code: "no_account", nextAvailable: { account: "acct-a", at: new Date(2026, 10, 18, 3, 5).getTime() } }, now);
    expect(tomorrow.message).toContain("次に空くのは 11/18 03:05 ごろ（acct-a）");
    expect(clockText(new Date(2026, 10, 17, 0, 0).getTime(), now)).toBe("00:00");
  });
  test("次に空く時刻が分からないときは、そう書く", () => {
    const e = refusalError({ code: "no_account", nextAvailable: null }, now);
    expect(e.kind).toBe("no_account");
    expect(e.message).toContain("次に空く時刻は分からなかった");
  });
  test("引き継ぎの最中と、会話が無いセッション", () => {
    expect(refusalError({ code: "succeeding" }, now).message).toContain("いま引き継いでいる最中");
    expect(refusalError({ code: "empty" }, now).message).toContain("まだ会話が無い");
  });
  test("知らない断りは、ccn の文と状態をそのまま出す", () => {
    expect(refusalError({ status: 400, error: "cwd is outside roots" }, now).message).toBe("ccn が断った（400）: cwd is outside roots");
    expect(refusalError({ status: 409, code: "new_code", error: "something new" }, now).kind).toBe("other");
  });
});
