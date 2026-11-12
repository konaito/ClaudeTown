// お便り（人の番の知らせ）を、全部の町（ccn のノード）から集めて並べる規則。純関数なので src/mail.test.ts で確かめる。
// 並び順（2026-11-12 本人の決定）:
//   1. 世帯の根（親）からのお便りを、町を問わず先に出す。子や孫からのお便りはその後
//   2. それぞれの中は、待たせている時間が長い順（待ち始めが古い順）
//   3. 同じ時刻なら町の名前、セッション ID の順（毎回同じ並びにする）
// 承認待ちか返事待ちか報告かでは並べ替えない（親が子より後に来ないことを優先する）。
import { moodOf, type Agent } from "./model";

export type MailKind = "approval" | "reply" | "done";

export type Mail = {
  agent: Agent;
  /** お便りの出た町（ノード名）。いま見ている町なら null ではなく、その町の名前が入る */
  town: string;
  /** 世帯の根（親がいない）か */
  root: boolean;
  kind: MailKind;
  /** 待ち始めの時刻（ms）。分からなければ Infinity（一番後ろ） */
  since: number;
};

/** 1つの町の一覧から、その町のお便りを作る */
export function mailOf(town: string, agents: Agent[]): Mail[] {
  const live = new Set(agents.map((a) => a.id));
  const out: Mail[] = [];
  for (const a of agents) {
    const m = moodOf(a);
    if (m !== "approval" && m !== "reply" && m !== "done") continue;
    out.push({
      agent: a,
      town,
      root: !a.parent || !live.has(a.parent),
      kind: m,
      since: waitingSince(a),
    });
  }
  return out;
}

/** 待ち始めの時刻。hook の最後の更新（承認を求めた時、返事を終えた時）、無ければ ccn の最後の動き、無ければ開始時刻 */
export function waitingSince(a: Agent): number {
  return a.report?.updated_at ?? a.lastActivityAt ?? a.startedAt ?? Number.POSITIVE_INFINITY;
}

export function orderMail(list: Mail[]): Mail[] {
  return [...list].sort((x, y) =>
    Number(!x.root) - Number(!y.root)
    || (x.since === y.since ? 0 : x.since < y.since ? -1 : 1)
    || (x.town < y.town ? -1 : x.town > y.town ? 1 : 0)
    || (x.agent.id < y.agent.id ? -1 : x.agent.id > y.agent.id ? 1 : 0));
}

/** 全部の町のお便りを集めて並べる */
export function collectMail(towns: { town: string; agents: Agent[] }[]): Mail[] {
  return orderMail(towns.flatMap((t) => mailOf(t.town, t.agents)));
}
