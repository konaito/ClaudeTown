import { describe, expect, test } from "bun:test";
import { answerPermission, PLAN_DENY_DEFAULT } from "./webPerm";

const detail = (o: Record<string, unknown> = {}) => ({ state: "waiting_permission", capabilities: { permissions: true }, pending: [{ requestId: "r1", toolName: "Bash", input: {} }], ...o });
const run = (d: unknown, choice: string, expect: string | null) => {
  const sent: [string, unknown][] = [];
  const p = answerPermission(async () => d, async (path, body) => { sent.push([path, body]); return null; }, "s1", choice, expect);
  return { p, sent };
};

describe("answerPermission", () => {
  test("許可は requestId が合うときだけ送る", async () => {
    const { p, sent } = run(detail(), "allow", "r1");
    expect(await p).toBe("許可した（Bash）");
    expect(sent).toEqual([["/sessions/s1/permissions/r1", { behavior: "allow" }]]);
  });
  test("見せた中身と requestId が違えば、許可を送らない", async () => {
    const { p, sent } = run(detail(), "allow", "old");
    await expect(p).rejects.toThrow("中身が変わった");
    expect(sent).toEqual([]);
  });
  test("拒否は requestId が違っても送れる", async () => {
    const { p, sent } = run(detail(), "deny", null);
    expect(await p).toBe("拒否した（Bash）");
    expect(sent[0][1]).toMatchObject({ behavior: "deny" });
  });
  test("質問は、全部に答えがあるときだけ updatedInput の answers で送る", async () => {
    const input = { questions: [{ question: "色は？", options: [{ label: "赤" }] }, { question: "数は？", multiSelect: true, options: [] }] };
    const d = detail({ pending: [{ requestId: "r1", toolName: "AskUserQuestion", input }] });
    const none = run(d, "allow", "r1");
    await expect(none.p).rejects.toThrow("答えが無い");
    const part = answerPermission(async () => d, async () => null, "s1", "allow", "r1", { "色は？": "赤" });
    await expect(part).rejects.toThrow("数は？");
    const sent: unknown[] = [];
    const ok = await answerPermission(async () => d, async (_p, b) => { sent.push(b); return null; }, "s1", "allow", "r1", { "色は？": " 赤 ", "数は？": "1, 2" });
    expect(ok).toBe("質問に答えた");
    expect(sent).toEqual([{ behavior: "allow", updatedInput: { ...input, answers: { "色は？": "赤", "数は？": "1, 2" } } }]);
  });
  test("計画は許可で承認し、拒否で理由を付けて見直しを頼む", async () => {
    const d = detail({ pending: [{ requestId: "r1", toolName: "ExitPlanMode", input: { plan: "p" } }] });
    const a = run(d, "allow", "r1");
    expect(await a.p).toBe("計画を承認した");
    expect(a.sent[0][1]).toEqual({ behavior: "allow" });
    const sent: unknown[] = [];
    await answerPermission(async () => d, async (_p, b) => { sent.push(b); return null; }, "s1", "deny", null, null, "テストも");
    expect(sent).toEqual([{ behavior: "deny", message: "テストも" }]);
    const dflt = run(d, "deny", null);
    await dflt.p;
    expect(dflt.sent[0][1]).toEqual({ behavior: "deny", message: PLAN_DENY_DEFAULT });
  });
  test("質問でない待ちに答えを付けたら送らない", async () => {
    await expect(answerPermission(async () => detail(), async () => null, "s1", "allow", "r1", { x: "y" })).rejects.toThrow("質問ではない");
  });
  test("もう承認待ちでない、答えられないセッション、要求なしは送らない", async () => {
    await expect(run(detail({ state: "idle" }), "deny", null).p).rejects.toThrow("もう承認待ちではない");
    await expect(run(detail({ capabilities: { permissions: false } }), "deny", null).p).rejects.toThrow("ターミナルで答えて");
    await expect(run(detail({ pending: [] }), "deny", null).p).rejects.toThrow("見当たらない");
  });
  test("choice が不正なら読みに行かない", async () => {
    await expect(run(detail(), "maybe", null).p).rejects.toThrow("allow か deny");
  });
});

describe("常に許可", () => {
  const sug = [
    { type: "addRules", rules: [{ toolName: "mcp__ccn__list_peers" }], behavior: "allow", destination: "localSettings" },
    { type: "addDirectories", directories: ["/x"], destination: "session" },
  ];
  const d = detail({ pending: [{ requestId: "r1", toolName: "mcp__ccn__list_peers", input: {}, suggestions: sug }] });
  const go = (choice: string, expect: string | null, i: number) => {
    const sent: unknown[] = [];
    const p = answerPermission(async () => d, async (_p, b) => { sent.push(b); return null; }, "s1", choice, expect, null, null, i);
    return { p, sent };
  };
  test("pending の提案をそのまま updatedPermissions で返す", async () => {
    const r = go("allow", "r1", 0);
    expect(await r.p).toContain("以後は聞かない");
    expect(r.sent).toEqual([{ behavior: "allow", updatedPermissions: [sug[0]] }]);
  });
  test("addDirectories、無い番号、拒否、中身の変わった要求には付けない", async () => {
    await expect(go("allow", "r1", 1).p).rejects.toThrow("提案に無い");
    await expect(go("allow", "r1", 5).p).rejects.toThrow("提案に無い");
    await expect(go("deny", null, 0).p).rejects.toThrow("付けない");
    await expect(go("allow", "old", 0).p).rejects.toThrow("変わった");
  });
});
