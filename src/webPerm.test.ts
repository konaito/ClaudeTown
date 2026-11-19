import { describe, expect, test } from "bun:test";
import { answerPermission } from "./webPerm";

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
  test("質問と計画の確認の待ちには、許可を送らない", async () => {
    const { p, sent } = run(detail({ pending: [{ requestId: "r1", toolName: "AskUserQuestion" }] }), "allow", "r1");
    await expect(p).rejects.toThrow("道具の承認ではない");
    expect(sent).toEqual([]);
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
