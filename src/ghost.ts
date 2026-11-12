// 転出のゴースト。子だけが別の町（ccn のノード）へ転出したとき、木を読めるように、相手の町にいる親子の影を置く。純関数（src/ghost.test.ts）。
//
// 2026-11-12 に fc-teleport-test が試験ノード2つ（#18＋#19 を手元でマージ）で確かめたこと:
// - 転出してもセッション ID は変わらない（move のとき）
// - 転出の要求に元の parent を x-ccn-from で付けると、移った先でも parent が agent:<元のノード>/<親の sid8>/<役割> のまま残る。
//   付けないと local になり、つながりは消える（Claude Town の転出は付けて頼む。src-tauri/src/lib.rs の teleport）
// - 元の町には、移ったセッションが exited で残り、parent は消える（一覧の live には出ない）
// - 孫の parent は、同じく移った子を元のノード名のまま指す。だから親はノード名ではなく、sid8 で全部の町から探す
//
// 出すもの:
// - 子の町: 親がこの町にいない子の上に、親のゴースト（「親は <町>」）。子はゴーストの子としてつなぐ
// - 親の町: 別の町にいる子の位置に、子のゴースト（「<町> へ転出」）
// 親と子が同じ町にいれば（子孫ごとの転出、親の転出は必ずこれ）、ゴーストは出ない。
// 消えるとき: 親か子が閉じられて一覧から消えたとき、同じ町にそろったとき。どちらも一覧から毎回作り直すので、記録は持たない。
import type { Agent } from "./model";

export type Town = { town: string; agents: Agent[] };

/** parent の生の値から、親のセッション ID の先頭8字を取る */
export function parentSid8(raw: string | null | undefined): string | null {
  return raw?.match(/^agent:[^/\s]+\/([0-9a-f]{8})/i)?.[1]?.toLowerCase() ?? null;
}

const findBySid8 = (agents: Agent[], sid8: string) => {
  const hit = agents.filter((a) => !a.ghost && a.id.toLowerCase().startsWith(sid8));
  return hit.length === 1 ? hit[0] : null;
};

/**
 * いま見ている町の一覧に、ゴーストを足した一覧を返す（木を作るときだけに使う。お便りや数には使わない）。
 * others は、いま見ている町以外の町の一覧。
 */
export function withGhosts(cur: Town, others: Town[]): Agent[] {
  const out: Agent[] = cur.agents.map((a) => ({ ...a }));
  const byId = new Map(out.map((a) => [a.id, a]));
  const added = new Set<string>();
  // 子の町: 親がこの町にいない子
  for (const x of out) {
    if (x.parent) continue;
    const sid8 = parentSid8(x.parentRaw);
    if (!sid8 || findBySid8(cur.agents, sid8)) continue;
    for (const t of others) {
      const p = findBySid8(t.agents, sid8);
      if (!p) continue;
      const gid = `ghost:${p.id}`;
      if (!added.has(gid)) {
        added.add(gid);
        out.push(ghost(p, t.town, null, "parent"));
      }
      x.parent = gid;
      break;
    }
  }
  // 親の町: 別の町にいて、そこでは親が見つからない子
  for (const t of others) {
    for (const x of t.agents) {
      if (x.ghost || x.parent) continue;
      const sid8 = parentSid8(x.parentRaw);
      if (!sid8 || findBySid8(t.agents, sid8)) continue;
      const p = findBySid8(cur.agents, sid8);
      if (!p || !byId.has(p.id)) continue;
      const gid = `ghost:${x.id}`;
      if (added.has(gid)) continue;
      added.add(gid);
      out.push(ghost(x, t.town, p.id, "child"));
    }
  }
  return out;
}

function ghost(real: Agent, town: string, parent: string | null, role: "parent" | "child"): Agent {
  return {
    id: `ghost:${real.id}`,
    name: real.name,
    kind: real.kind,
    state: "idle",
    cwd: real.cwd,
    startedAt: real.startedAt,
    canSend: false,
    parent,
    avatar: real.avatar,
    capabilities: null,
    ghost: { town, realId: real.id, role },
  };
}
