import { describe, expect, test } from "bun:test";
import { SUCCEED_POLL_MS, SUCCEED_WAIT_MS, handoffPrompt, kidsOf, startSuccessor, succeedBlock, type SucceedDeps } from "./succeed";
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

describe("後継を立てる", () => {
  test("根の後継は親なしで、前任の cwd と ID の付け直し（resume と fork）で立てる", async () => {
    const f = fake({
      details: { [OLD]: [{ state: "idle", depth: 0, title: "succeed-test-R" }], [NEW]: [{ state: "running", cursor: 0 }, { state: "running", cursor: 1 }] },
      created: { id: NEW, cwd: "/w/meta", depth: 0 },
    });
    const r = await startSuccessor({ agent: ag(), kids: [], ...size }, f.d);
    expect(r).toEqual({ kind: "took", id: NEW, cwd: "/w/meta", depth: 0, depthChecked: true });
    const create = f.calls.find((c) => c.cmd === "create_session")!.args;
    expect(create).toMatchObject({ cwd: "/w/meta", parent: null, resume: OLD, fork: true, peer: null, name: "succeed-test-R", cols: 120, rows: 40 });
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
