import { describe, expect, test } from "bun:test";
import { allowedSuggestion, answerPermission, DENY_DEFAULT, permissionBody, PLAN_DENY_DEFAULT, type Pending } from "./webPerm";
import permCases from "./perm-cases.json";

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
  test("拒否も requestId が合うときだけ送る", async () => {
    const { p, sent } = run(detail(), "deny", "r1");
    expect(await p).toBe("拒否した（Bash）");
    expect(sent).toEqual([["/sessions/s1/permissions/r1", { behavior: "deny", message: DENY_DEFAULT }]]);
    for (const e of ["old", null]) {
      const x = run(detail(), "deny", e);
      await expect(x.p).rejects.toThrow("中身が変わった");
      expect(x.sent).toEqual([]);
    }
  });
  test("見せた承認 r1 が済んで r2 が待ちに入ったら、拒否も理由も r2 に送らない（#226）", async () => {
    const d = detail({ pending: [{ requestId: "r2", toolName: "Bash", input: { command: "rm -rf x" } }] });
    const sent: unknown[] = [];
    const p = answerPermission(async () => d, async (path, body) => { sent.push([path, body]); return null; }, "s1", "deny", "r1", null, "A の理由");
    await expect(p).rejects.toThrow("中身が変わった");
    expect(sent).toEqual([]);
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
    await answerPermission(async () => d, async (_p, b) => { sent.push(b); return null; }, "s1", "deny", "r1", null, "テストも");
    expect(sent).toEqual([{ behavior: "deny", message: "テストも" }]);
    const dflt = run(d, "deny", "r1");
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
    await expect(go("deny", "r1", 0).p).rejects.toThrow("付けない");
    await expect(go("allow", "old", 0).p).rejects.toThrow("変わった");
  });
});

// 承認の返事の決まりの事例。Rust 側の同じ処理（permission.rs）は消え、今はこの試験だけが読む
describe("承認の返事の組み立て（src/perm-cases.json）", () => {
  type A = { first: Pending; choice: string; expectId: string | null; answers: Record<string, string> | null; message: string | null; suggestion: number | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (fn: string, a: any): unknown => {
    switch (fn) {
      case "const":
        if (a[0] === "DENY_DEFAULT") return DENY_DEFAULT;
        if (a[0] === "PLAN_DENY_DEFAULT") return PLAN_DENY_DEFAULT;
        throw new Error(`知らない文: ${a[0]}`);
      case "allowed_suggestion": return allowedSuggestion(a[0]);
      case "permission_body": {
        const x = a as A;
        try {
          return permissionBody(x.first, x.choice, x.expectId, x.answers, x.message, x.suggestion);
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
    }
    throw new Error(`知らない関数: ${fn}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of permCases as { name: string; fn: string; args: any; expect: unknown }[]) {
    test(c.name, () => {
      expect(JSON.parse(JSON.stringify(run(c.fn, c.args)))).toEqual(c.expect);
    });
  }
});
