import { describe, expect, test } from "bun:test";
import type { Agent, Snapshot } from "./model";
import { reuseAgents, reuseSnap } from "./snap";

const ag = (id: string, state: Agent["state"] = "idle"): Agent => ({ id, name: id, kind: "node", state, cwd: `/tmp/${id}`, canSend: true, parent: null });
const snap = (agents: Agent[], at: number, letters: any[] = []): Snapshot => ({ ccn: "x", peer: null, ccn_ok: true, ccn_error: null, agents, letters, fetched_at: at });

describe("reuseSnap（#4）", () => {
  test("取得した時刻のほかが同じなら、前回のオブジェクトを返す", () => {
    const a = snap([ag("a"), ag("b")], 1);
    const b = snap([ag("a"), ag("b")], 2);
    expect(reuseSnap(a, b)).toBe(a);
  });

  test("1人だけ変わったら、新しい一覧を返し、変わらない人は前回のオブジェクトを使い回す", () => {
    const a = snap([ag("a"), ag("b")], 1);
    const b = snap([ag("a"), ag("b", "running")], 2);
    const r = reuseSnap(a, b);
    expect(r).not.toBe(a);
    expect(r.agents[0]).toBe(a.agents[0]);
    expect(r.agents[1]).not.toBe(a.agents[1]);
    expect(r.agents[1].state).toBe("running");
  });

  test("お手紙が増えたら、新しい一覧を返す。セッションは使い回す", () => {
    const a = snap([ag("a")], 1, []);
    const b = snap([ag("a")], 2, [{ ev: "sent", id: "l1", at: 5 }]);
    const r = reuseSnap(a, b);
    expect(r).not.toBe(a);
    expect(r.agents).toBe(a.agents);
    expect(r.letters).toHaveLength(1);
  });

  test("つながらなくなったら、新しい一覧を返す", () => {
    const a = snap([ag("a")], 1);
    const b = { ...snap([ag("a")], 2), ccn_ok: false, ccn_error: "x" };
    expect(reuseSnap(a, b)).not.toBe(a);
  });
});

describe("reuseAgents（#4）", () => {
  test("人が減ったり並びが変わったりしたら、新しい並びを返す", () => {
    const prev = [ag("a"), ag("b")];
    expect(reuseAgents(prev, [ag("a")])).not.toBe(prev);
    const swapped = reuseAgents(prev, [ag("b"), ag("a")]);
    expect(swapped).not.toBe(prev);
    expect(swapped[0]).toBe(prev[1]);
  });
});
