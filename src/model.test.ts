import { describe, expect, test } from "bun:test";
import { accountText, cardNames, houseNameOf, projectFromPath, targetLabel, type Agent, type Who } from "./model";
import cases from "./naming-cases.json";

const ag = (id: string, cwd: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: "terminal", state: "idle", cwd, canSend: true, parent: null, ...over,
});

// src-tauri/src/naming.rs の shared_cases と同じ事例
describe("cardNames（src/naming-cases.json）", () => {
  for (const c of cases as { name: string; sessions: Who[]; expect: Record<string, string> }[]) {
    test(c.name, () => {
      const got = cardNames(c.sessions);
      for (const [id, want] of Object.entries(c.expect)) expect(got.get(id)).toBe(want);
    });
  }
});

describe("プロジェクトの名前", () => {
  test("worktree はパスの形でも本体の名前", () => {
    expect(projectFromPath("/Users/x/Documents/family-computing.wt/chat")).toBe("family-computing");
    expect(projectFromPath("/a/b/")).toBe("b");
    expect(projectFromPath("/a/.wt/x")).toBe("x");
  });
});

describe("houseNameOf", () => {
  test("根のカードの名前（親のプロジェクトの名前）", () => {
    const root = ag("r", "/Users/x/Documents/family-computing", { name: "family-computing" });
    expect(houseNameOf(root)).toBe("family-computing");
  });
  test("親が meta なら世帯の名前は meta。子のプロジェクトにはならない", () => {
    const names = cardNames([
      { id: "p", cwd: "/Users/x/Documents/meta" },
      { id: "c", cwd: "/Users/x/Documents/voice-clone", parent: "p" } as Who,
    ]);
    expect(houseNameOf(ag("p", "/Users/x/Documents/meta", { name: names.get("p")! }))).toBe("meta");
  });
});

describe("targetLabel", () => {
  test("同じ名前がいなければ名前だけ", () => {
    const a = ag("aaaaaaaa-1", "/tmp/a", { name: "a" });
    expect(targetLabel(a, [a, ag("bbbbbbbb-2", "/tmp/b", { name: "b" })])).toBe("a");
  });
  test("同じ名前がいたら ID の先頭8字を添える", () => {
    const a = ag("aaaaaaaa-1", "/tmp", { name: "tmp" });
    const b = ag("bbbbbbbb-2", "/tmp", { name: "tmp" });
    expect(targetLabel(a, [a, b])).toBe("tmp（aaaaaaaa）");
    expect(targetLabel(b, [a, b])).toBe("tmp（bbbbbbbb）");
  });
});

describe("アカウントの表示", () => {
  test("名前と email があれば「名前（email）」、email が無ければ名前だけ", () => {
    expect(accountText(ag("a", "/w", { account: "acct-a", accountEmail: "a@example.invalid" }))).toBe("acct-a（a@example.invalid）");
    expect(accountText(ag("a", "/w", { account: "acct-a" }))).toBe("acct-a");
  });
  test("アカウントが無い（古い ccn、選べなかったセッション）なら null", () => {
    expect(accountText(ag("a", "/w"))).toBeNull();
    expect(accountText(ag("a", "/w", { account: null, accountEmail: "a@example.invalid" }))).toBeNull();
  });
});
