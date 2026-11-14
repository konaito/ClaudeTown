import { describe, expect, test } from "bun:test";
import { cardNames, houseNameOf, isDispatchPlace, projectFromPath, speakerName, targetLabel, type Agent, type Who } from "./model";
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

describe("振り分けの場所とプロジェクトの名前", () => {
  test("振り分けの場所", () => {
    for (const p of ["/Users/x/Documents/meta", "/Users/x/Documents/meta/", "/Users/x", "/home/x/.local/share/ccn/lobby", "/tmp", "/private/tmp", "/", "/Users/x/Documents"]) {
      expect(isDispatchPlace(p)).toBe(true);
    }
    for (const p of ["/Users/x/Documents/meta.wt/delegation", "/Users/x/Documents/family-computing", "/tmp/foo", "/Users/x/Documents/meta/sub"]) {
      expect(isDispatchPlace(p)).toBe(false);
    }
  });
  test("worktree はパスの形でも本体の名前", () => {
    expect(projectFromPath("/Users/x/Documents/family-computing.wt/chat")).toBe("family-computing");
    expect(projectFromPath("/a/b/")).toBe("b");
    expect(projectFromPath("/a/.wt/x")).toBe("x");
  });
});

describe("houseNameOf", () => {
  test("根のカードの名前（プロジェクトの名前）", () => {
    const root = ag("r", "/Users/x/Documents/meta", { name: "family-computing" });
    expect(houseNameOf(root, [root])).toEqual({ name: "family-computing", by: "project" });
  });
  test("本人が付けた名前が最優先", () => {
    const root = ag("r", "/Users/x/Documents/meta", { name: "family-computing", house: { name: "うち", by: "human" } });
    expect(houseNameOf(root, [root])).toEqual({ name: "うち", by: "human" });
  });
  test("エージェントが付けた名前は、根のカードの名前を通してだけ使う", () => {
    const root = ag("r", "/Users/x/Documents/family-computing", { name: "family-computing", house: { name: "ファミコン作り", by: "agent" } });
    expect(houseNameOf(root, [root]).name).toBe("family-computing");
  });
});

describe("speakerName（発言の差出人の名前）", () => {
  test("振り分けの場所の親は、子孫のプロジェクトでなく自分の cwd の名前", () => {
    const sessions: Who[] = [
      { id: "p", cwd: "/Users/x/Documents/meta" },
      { id: "c", cwd: "/Users/x/Documents/family-computing", parent: "p" },
    ];
    const names = cardNames(sessions);
    expect(names.get("p")).toBe("family-computing");
    expect(speakerName(ag("p", "/Users/x/Documents/meta", { name: names.get("p")! }))).toBe("meta");
    expect(speakerName(ag("c", "/Users/x/Documents/family-computing", { name: names.get("c")! }))).toBe("family-computing");
  });
  test("ふつうの場所ではカードの名前のまま（worktree は本体の名前）", () => {
    expect(speakerName(ag("a", "/Users/x/Documents/family-computing.wt/chat", { name: "family-computing" }))).toBe("family-computing");
  });
  test("ホーム、ccn の受け口、/、cwd 無し", () => {
    expect(speakerName(ag("a", "/Users/x", { name: "family-computing" }))).toBe("x");
    expect(speakerName(ag("a", "/Users/x/.local/share/ccn/lobby", { name: "family-computing" }))).toBe("lobby");
    expect(speakerName(ag("a", "/", { name: "family-computing" }))).toBe("/");
    expect(speakerName(ag("a", "", { name: "題名" }))).toBe("題名");
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
