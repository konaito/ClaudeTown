import { describe, expect, test } from "bun:test";
import { houseNameOf, type Agent } from "./model";

const ag = (id: string, cwd: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: "terminal", state: "idle", cwd, canSend: true, parent: null, ...over,
});

describe("houseNameOf", () => {
  test("meta の根は meta", () => {
    const root = ag("r", "/Users/x/Documents/meta");
    expect(houseNameOf(root, [root])).toEqual({ name: "meta", by: "dir" });
  });
  test("meta の子も meta のまま（子の場所を数えない）", () => {
    const root = ag("r", "/Users/x/Documents/meta");
    const kids = [ag("a", "/Users/x/Documents/meta", { parent: "r" }), ag("b", "/Users/x/Documents/meta", { parent: "r" })];
    expect(houseNameOf(root, [root, ...kids]).name).toBe("meta");
  });
  test("別のディレクトリの子がいても根の名前", () => {
    const root = ag("r", "/Users/x/Documents/meta");
    const kids = [ag("a", "/Users/x/Documents/sidenote", { parent: "r" }), ag("b", "/Users/x/Documents/sidenote", { parent: "r" })];
    expect(houseNameOf(root, [root, ...kids]).name).toBe("meta");
  });
  test("人が付けた名前が優先", () => {
    const root = ag("r", "/Users/x/Documents/meta", { house: { name: "うち", by: "human" } });
    expect(houseNameOf(root, [root])).toEqual({ name: "うち", by: "human" });
  });
  test("エージェントが付けた名前と最初の依頼は使わない", () => {
    const root = ag("r", "/Users/x/Documents/meta", { house: { name: "ccn（Claude…", by: "agent" }, report: { asked: "[Image #5] 安定版を" } as Agent["report"] });
    expect(houseNameOf(root, [root])).toEqual({ name: "meta", by: "dir" });
  });
  test("cwd の末尾のスラッシュは無視する", () => {
    expect(houseNameOf(ag("r", "/a/b/"), []).name).toBe("b");
  });
});
