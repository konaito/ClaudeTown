import { describe, expect, test } from "bun:test";
import { parentSid8, rootIds, withGhosts } from "./ghost";
import { buildTree, type Agent } from "./model";

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

// ポケモンの系統は世帯の根の ID で決まる。町によって根が違うと、親子なのに系統が割れる
describe("世帯の根が町によらず同じ", () => {
  const GP = "aaaaaaaa-0000-0000-0000-00000000000a"; // 祖父
  const H = "dddddddd-0000-0000-0000-00000000000d"; // 玄孫
  // App.tsx の旧 rootOf と同じ決め方（木の根。ゴーストなら realId）
  const treeRoot = (cur: { town: string; agents: Agent[] }, others: { town: string; agents: Agent[] }[], id: string) => {
    const t = buildTree(withGhosts(cur, others));
    const r = t.lineage(t.byId.get(id)!)[0];
    return r.ghost?.realId ?? r.id;
  };

  // 祖父-親は町A、子と孫は町B（親の転出ではなく子の転出）
  const A = { town: "tp-a", agents: [ag(GP, "local"), ag(P, "agent:tp-a/aaaaaaaa/test", GP)] };
  const B = { town: "tp-b", agents: [ag(K, "agent:tp-a/9bf1ce0a/test"), ag(G, "agent:tp-a/bcbd556c/test", K)] };

  test("再現: 旧い決め方だと、親の町は祖父、子の町は親が根になって割れる", () => {
    expect(treeRoot(A, [B], P)).toBe(GP);
    expect(treeRoot(B, [A], K)).toBe(P);
  });

  test("直した決め方: どの町から見ても、祖父・親・子・孫が同じ根", () => {
    for (const towns of [[A, B], [B, A]]) {
      const r = rootIds(towns);
      for (const id of [GP, P, K, G]) expect(r.get(id)).toBe(GP);
    }
  });

  test("親だけが根（祖父なし）なら、親が根で今まで通り", () => {
    const A2 = { town: "tp-a", agents: [ag(P, "local")] };
    expect(rootIds([A2, B]).get(G)).toBe(P);
    expect(treeRoot(B, [A2], K)).toBe(P);
  });

  test("4世代が3つの町にまたがっても同じ根", () => {
    const B2 = { town: "tp-b", agents: [ag(K, "agent:tp-a/9bf1ce0a/test"), ag(G, "agent:tp-b/bcbd556c/test", K)] };
    const C2 = { town: "tp-c", agents: [ag(H, "agent:tp-b/1272d4a3/test")] };
    const r = rootIds([C2, A, B2]);
    expect([GP, P, K, G, H].map((id) => r.get(id))).toEqual([GP, GP, GP, GP, GP]);
  });

  test("親が閉じて見つからない子は、その子が根（町ごとに変わらない）", () => {
    const lone = { town: "tp-b", agents: [ag(K, "agent:tp-a/9bf1ce0a/test")] };
    expect(rootIds([lone, { town: "tp-a", agents: [] }]).get(K)).toBe(K);
    expect(rootIds([{ town: "tp-a", agents: [] }, lone]).get(K)).toBe(K);
  });

  test("親子が逆に指し合っても止まる", () => {
    const loop = { town: "tp-a", agents: [ag(P, "agent:tp-a/bcbd556c/test"), ag(K, "agent:tp-a/9bf1ce0a/test")] };
    expect(rootIds([loop]).size).toBe(2);
  });
});
