import { describe, expect, test } from "bun:test";
import { parentSid8, withGhosts } from "./ghost";
import type { Agent } from "./model";

// 試験ノードの記録（/tmp/ccn-tp/out の b と c）と同じ形の一覧
const ag = (id: string, parentRaw: string | null, parent: string | null = null): Agent => ({
  id, name: id.slice(0, 8), kind: "node", state: "idle", cwd: "/", canSend: true, parent, parentRaw,
});
const P = "9bf1ce0a-0000-0000-0000-000000000001";
const K = "bcbd556c-0000-0000-0000-000000000002";
const G = "1272d4a3-0000-0000-0000-000000000003";

describe("parent の生の値", () => {
  test("agent 行から sid8 を取る", () => expect(parentSid8("agent:tp-a/9bf1ce0a/test")).toBe("9bf1ce0a"));
  test("local と空は null", () => {
    expect(parentSid8("local")).toBeNull();
    expect(parentSid8(null)).toBeNull();
  });
});

describe("子だけの転出（c: 親は町A、子と孫は町B）", () => {
  const A = { town: "tp-a", agents: [ag(P, "local")] };
  const B = { town: "tp-b", agents: [ag(K, "agent:tp-a/9bf1ce0a/test"), ag(G, "agent:tp-a/bcbd556c/test", K)] };

  test("町B: 子の上に親のゴーストを置き、孫はそのまま子につながる", () => {
    const t = withGhosts(B, [A]);
    const g = t.find((a) => a.ghost);
    expect(g).toMatchObject({ id: `ghost:${P}`, parent: null, ghost: { town: "tp-a", realId: P, role: "parent" } });
    expect(t.find((a) => a.id === K)?.parent).toBe(`ghost:${P}`);
    expect(t.find((a) => a.id === G)?.parent).toBe(K);
  });

  test("町A: 親の下に、移った子のゴーストを1つだけ置く（孫の分は出さない）", () => {
    const t = withGhosts(A, [B]);
    const gs = t.filter((a) => a.ghost);
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ id: `ghost:${K}`, parent: P, ghost: { town: "tp-b", realId: K, role: "child" } });
  });

  test("元の一覧は書き換えない", () => {
    withGhosts(B, [A]);
    expect(B.agents[0].parent).toBeNull();
  });
});

describe("ゴーストを出さない場合", () => {
  test("親を子孫ごと転出（a: 3人とも町B）", () => {
    const B = { town: "tp-b", agents: [ag(P, "local"), ag(K, "agent:tp-a/9bf1ce0a/test", P), ag(G, "agent:tp-a/bcbd556c/test", K)] };
    expect(withGhosts(B, [{ town: "tp-a", agents: [] }]).some((a) => a.ghost)).toBe(false);
  });

  test("x-ccn-from を付けずに転出して parent が local になった（b）", () => {
    const A = { town: "tp-a", agents: [ag(P, "local")] };
    const B = { town: "tp-b", agents: [ag(K, "local")] };
    expect(withGhosts(A, [B]).some((a) => a.ghost)).toBe(false);
    expect(withGhosts(B, [A]).some((a) => a.ghost)).toBe(false);
  });

  test("親が閉じられた（どの町にもいない）", () => {
    const B = { town: "tp-b", agents: [ag(K, "agent:tp-a/9bf1ce0a/test")] };
    expect(withGhosts(B, [{ town: "tp-a", agents: [] }]).some((a) => a.ghost)).toBe(false);
  });

  test("届かない町は others に入らないので、その町の相手のゴーストは出ない", () => {
    const B = { town: "tp-b", agents: [ag(K, "agent:tp-a/9bf1ce0a/test")] };
    expect(withGhosts(B, []).some((a) => a.ghost)).toBe(false);
  });
});

describe("使い回し（#4）", () => {
  test("書き換えないセッションは元のオブジェクトのまま返し、入力は書き換えない", () => {
    const A = { town: "tp-a", agents: [ag(P, "local")] };
    const B = { town: "tp-b", agents: [ag(K, "agent:tp-a/9bf1ce0a/test"), ag(G, "agent:tp-a/bcbd556c/test", K)] };
    const t = withGhosts(B, [A]);
    expect(t.find((a) => a.id === G)).toBe(B.agents[1]);
    expect(t.find((a) => a.id === K)).not.toBe(B.agents[0]);
    expect(B.agents[0].parent).toBeNull();
  });
});
