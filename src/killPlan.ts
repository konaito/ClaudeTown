import type { Agent } from "./model";
import { canStop } from "./abilities";

/** 親の claude のプロセスの中で動く子か。sub-agent と in-process のチームメイトがそう。親の claude が終わると一緒に終わる。
 *  行の出どころで決める。src-tauri/src/native/subagents.rs の行は kind が subagent か teammate で、pid が null。
 *  src-tauri/src/native/teams.rs の tmux のチームメイトは kind が teammate で、別のプロセスの pid を持つ */
export const inProcess = (a: Agent): boolean => (a.kind === "subagent" || a.kind === "teammate") && a.pid == null;

export type KillPlan = {
  /** 止める分。葉から順 */
  stop: Agent[];
  /** 止めずに残す分（外で起動した claude と、tmux のチームメイト）。in-process の子は入れない */
  keep: Agent[];
  /** 親の claude と一緒に終わる in-process の子と、その親（with）。with が止まれば終わり、止まらなければ残る */
  ride: { agent: Agent; with: Agent }[];
  /** 閉じる子孫の人数（a を除く止める分と、止める分に乗る in-process の子） */
  descendants: number;
};

/** a とその子孫を閉じるときの、止める順と残す分。a が止められるときに呼ぶ */
export function killPlan(childrenOf: Map<string, Agent[]>, a: Agent): KillPlan {
  const stop: Agent[] = [];
  const keep: Agent[] = [];
  const ride: KillPlan["ride"] = [];
  // carrier は x を中で動かしている、いちばん近い in-process でない祖先
  const walk = (x: Agent, carrier: Agent | null) => {
    const mine = inProcess(x) ? carrier : x;
    for (const k of childrenOf.get(x.id) ?? []) walk(k, mine);
    if (inProcess(x)) {
      if (carrier) ride.push({ agent: x, with: carrier });
      else keep.push(x);
    } else if (canStop(x)) stop.push(x);
    else keep.push(x);
  };
  walk(a, null);
  return { stop, keep, ride, descendants: closedDescendants(a, ride, stop) };
}

/** 閉じた子孫の人数。ok は止まった分（a を含みうる）。ride は止まった分に乗っているものだけ数える */
export function closedDescendants(a: Agent, ride: KillPlan["ride"], ok: Agent[]): number {
  const done = new Set(ok.map((x) => x.id));
  return ok.filter((x) => x.id !== a.id).length + ride.filter((r) => done.has(r.with.id)).length;
}
