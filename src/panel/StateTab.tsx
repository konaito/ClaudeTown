import type { Agent, Mood } from "../model";
import { accountText, nowOf } from "../model";
import { ScrollEdgeGradient } from "../ScrollEdgeGradient";
import { linkify } from "../Markdown";
import { Since } from "../Since";

export function StateTab({ agent, mood }: { agent: Agent; mood: Mood }) {
  const r = agent.report;
  const rows: [string, React.ReactNode][] = [
    ["いま", nowOf(agent, mood)],
    ["頼まれたこと", r?.asked],
    ["最後の報告", r?.said],
    ["次の一手", r?.next],
    ["閉じていい？", agent.closeCheck ? (agent.closeCheck.status === "ok" ? "閉じてOK" : agent.closeCheck.status === "ng" ? `まだ: ${agent.closeCheck.short ?? ""}` : "判定中") : null],
    ["作業中の時間", mood === "working" && r?.turn_started_at ? <Since at={r.turn_started_at} /> : null],
    ["アカウント", accountText(agent)],
    ["場所", agent.cwd.replace(/^\/Users\/[^/]+/, "~")],
    ["セッション", agent.id],
  ];
  return (
    <ScrollEdgeGradient className="state-scroll" wrapClassName="seg-fill"><dl className="state-tab">
      {rows.filter(([, v]) => v).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{typeof v === "string" ? linkify(v) : v}</dd></div>))}
      {!r && <p className="hint">状態 hook が入っていないので、頼まれたことと次の一手は出ない（README の「hook」を参照）。</p>}
    </dl></ScrollEdgeGradient>
  );
}
