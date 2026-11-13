// お手紙（セッションどうしのやり取り）を、町の上で飛ばす封筒に直す規則。純関数なので src/letters.test.ts で確かめる。
// お便り（人の番の知らせ、src/mail.ts）とは別のもの。
//
// 記録は状態 hook（hooks/fc-report.py）が ~/.family-computing/letters.jsonl に書く:
//   sent      送り手の PostToolUse。SendMessage、ccn の send_message、ccn の create_session。宛先は生のまま
//   received  受け手の UserPromptSubmit。<cross-session-message from=… from-name=…> か、1行目が from agent:<ノード>/<sid8>/… の文
// 宛先と送り手は、アプリが町の一覧からセッション ID に結び付ける（resolve）:
//   1. uds:/tmp/cc-socks/<pid>.sock の pid（Claude Code のソケットの pid は ccn の pid と同じ。2026-11-12 に確かめた）
//   2. セッション ID か、その先頭8字以上（"<ノード>/<ID>" の形も読む）
//   3. 題名（名前）が一覧の中で1人だけと一致するとき
//   どれでも1人に決まらなければ結ばない（推測で飛ばさない）。別の町のセッションも、この町の一覧にいないので結ばない。
// 1通に記録が2つ（sent と received）出るので、sent で飛ばし、対になる received を「読んだ」の印にする。
// 対になる received が無い sent も飛ばす。対になる sent が無い received（hook の無い送り手など）は、received の時刻で飛ばす。
import type { Agent } from "./model";

export type LetterRec = {
  ev: "sent" | "received";
  id: string;
  at: number;
  kind?: "send" | "ccn_send" | "ccn_create";
  from?: string;
  to?: string;
  to_id?: string | null;
  peer?: string | null;
  from_raw?: string | null;
  from_name?: string | null;
  from_node?: string | null;
  from_sid8?: string | null;
  summary?: string;
};

export type Flight = {
  /** 元の記録の id（同じ封筒を二度飛ばさないため） */
  id: string;
  from: string;
  to: string;
  at: number;
  summary: string;
  /** 受け手が読んだ時刻（対になる received の時刻）。まだなら null */
  readAt: number | null;
};

/** sent と received を対にするときの、時刻のずれの許し（送ってから届くまで。忙しい受け手は遅れて読む） */
export const PAIR_BEFORE_MS = 2_000;
export const PAIR_AFTER_MS = 10 * 60_000;

/** 宛先や送り手の文字列を、この町のセッション ID に結び付ける。1人に決まらなければ null */
export function resolve(raw: string | null | undefined, agents: Agent[]): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s*\[[^\]]*\]$/, "");
  const one = (xs: Agent[]) => (xs.length === 1 ? xs[0].id : null);
  const pid = s.match(/^uds:.*\/(\d+)\.sock$/);
  if (pid) return one(agents.filter((a) => a.pid === Number(pid[1])));
  const tail = s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
  if (/^[0-9a-f-]{8,36}$/i.test(tail)) {
    const hit = one(agents.filter((a) => a.id.toLowerCase().startsWith(tail.toLowerCase())));
    if (hit) return hit;
  }
  return one(agents.filter((a) => a.name === s));
}

/** 記録の並びから、飛ばす封筒の一覧を作る（古い順） */
export function flightsOf(recs: LetterRec[], agents: Agent[]): Flight[] {
  const live = new Set(agents.map((a) => a.id));
  const sent: Flight[] = [];
  for (const r of recs) {
    if (r.ev !== "sent" || !r.from || !live.has(r.from)) continue;
    const to = (r.to_id && live.has(r.to_id) ? r.to_id : null) ?? resolve(r.to_id, agents) ?? resolve(r.to, agents);
    if (!to || to === r.from) continue;
    sent.push({ id: r.id, from: r.from, to, at: r.at, summary: r.summary ?? "", readAt: null });
  }
  const out = [...sent];
  const used = new Set<string>();
  for (const r of recs) {
    if (r.ev !== "received" || !r.to || !live.has(r.to)) continue;
    const from = resolve(r.from_raw, agents) ?? resolve(r.from_sid8, agents) ?? resolve(r.from_name, agents);
    if (!from || from === r.to) continue;
    // 対になる sent: 同じ送り手と受け手で、受けた時刻の少し後から、10分前までに送ったもの。古い順に1通ずつ当てる
    const pair = sent.find((f) => !used.has(f.id) && f.from === from && f.to === r.to && f.at - PAIR_BEFORE_MS <= r.at && r.at - f.at <= PAIR_AFTER_MS);
    if (pair) {
      used.add(pair.id);
      pair.readAt = r.at;
    } else {
      out.push({ id: r.id, from, to: r.to, at: r.at, summary: r.summary ?? "", readAt: r.at });
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}
