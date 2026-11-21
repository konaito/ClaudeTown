import { memo, useContext } from "react";
import { resolve } from "../letters";
import type { Agent, ConvItem } from "../model";
import { Markdown, linkify } from "../Markdown";
import { chatPerf } from "../chatPerf";
import { Avatar, roleOf, type Role } from "../kid/Avatar";
import { TownCtx } from "../contexts";

/** 道具の行が続いたら1行にまとめる。まとめた行の n は最初の行の n にする（後ろに道具が増えても key が変わらない） */
export type Shown = ConvItem & { more?: number; group?: ConvItem[]; done?: number };

export function collapseTools(items: ConvItem[]): Shown[] {
  const out: Shown[] = [];
  for (const x of items) {
    const last = out[out.length - 1];
    if (x.role === "tool" && last?.role === "tool") {
      const group = [...(last.group ?? [last]), x];
      out[out.length - 1] = { ...x, n: last.n, more: (last.more ?? 0) + 1, group, done: group.filter((g) => g.result).length };
    } else out.push(x.role === "tool" ? { ...x, group: [x], done: x.result ? 1 : 0 } : x);
  }
  return out;
}

/**
 * 後から届いた道具の結果（role が result の項目）を、同じ id の道具の行に付け直し、結果の項目は外す（#83）。
 * Rust は、同じ読み出しで届いた結果を初めから道具の行に付けて渡す
 */
export function withResults(items: ConvItem[]): ConvItem[] {
  if (!items.some((x) => x.role === "result")) return items;
  const late = new Map<string, { text: string; error: boolean }>();
  for (const x of items) if (x.role === "result" && x.id) late.set(x.id, { text: x.text, error: !!x.error });
  return items.filter((x) => x.role !== "result").map((x) => (x.role === "tool" && !x.result && x.id && late.has(x.id) ? { ...x, result: late.get(x.id) } : x));
}

/** 時刻の書式。toLocaleTimeString は呼ぶたびに ICU の書式を作り直すので、1つを使い回す（#10） */
const HM = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });

/** at は node のセッションなら ISO の文字列、pty のセッションなら ms の数 */
function timeOf(at?: string | number | null): string {
  chatPerf.time++;
  if (!at) return "";
  const d = new Date(at);
  return isNaN(+d) ? "" : HM.format(d);
}

type BubbleProps = { item: Shown; agent: Agent; lineageDepth: number };

/**
 * 吹き出しは、中身か見た目に使う値が変わったときだけ描き直す（#10）。
 * agent は一覧を取るたびに別の物になるので、使う値（id、名前、cwd、絵）だけを比べる。
 * まとめた道具の行は毎回作り直すので、n と件数と文で比べる
 */
export const Bubble = memo(BubbleView, (a: BubbleProps, b: BubbleProps) =>
  (a.item === b.item || (a.item.n != null && a.item.n === b.item.n && a.item.more === b.item.more && a.item.done === b.item.done && a.item.text === b.item.text && a.item.pending === b.item.pending))
  && a.lineageDepth === b.lineageDepth
  && a.agent.id === b.agent.id && a.agent.name === b.agent.name && a.agent.cwd === b.agent.cwd
  && a.agent.avatar?.char === b.agent.avatar?.char && a.agent.avatar?.hue === b.agent.avatar?.hue);

/**
 * 道具の行。結果が届いた道具があれば、押すと開いて、道具ごとの1行と結果の頭を出す（#83）。
 * 続いた道具は1行にまとめたまま（「ほか N 件」）。結果が1つも無いうちは開けない
 */
function ToolLine({ item }: { item: Shown }) {
  const group = item.group ?? [item];
  const head = <>🔧 {linkify(item.text)}{item.more ? ` ほか${item.more}件` : ""}</>;
  if (!item.done) return <div className="tool-line">{head}</div>;
  const bad = group.some((g) => g.result?.error);
  return (
    <details className="tool-line tool-open">
      <summary>{head}{bad && <span className="tl-bad">失敗あり</span>}</summary>
      <div className="tl-list">
        {group.map((g, i) => (
          <div key={g.id ?? i} className="tl-item">
            <div className="tl-name">{linkify(g.text)}{g.result?.error && <span className="tl-bad">失敗</span>}</div>
            {g.result ? (g.result.text ? <pre className={`tl-out${g.result.error ? " bad" : ""}`}>{g.result.text}</pre> : <div className="hint">（出力なし）</div>) : <div className="hint">結果を待っている</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

function BubbleView({ item, agent, lineageDepth }: BubbleProps) {
  chatPerf.bubble++;
  if (item.role === "tool" && item.sent) return <SentLetter item={item} agent={agent} lineageDepth={lineageDepth} />;
  if (item.role === "tool") return <ToolLine item={item} />;
  if (item.role === "event") return <div className={`turn-event te-${item.kind ?? "error"}`}>{item.kind === "interrupted" ? "⏹ " : item.kind === "command" ? "" : "⚠️ "}{item.text}<span className="te-at">{timeOf(item.at)}</span></div>;
  if (item.role === "result") return null;
  if (item.role === "user" && item.letter) return <LetterBubble item={item} />;
  if (item.role === "user") {
    const who = item.from ? fromLabel(item.from) : null;
    return (
      <div className={`msg me ${item.pending ? "pending" : ""}`}>
        <div className="meta">{who && <span className="from">{who}</span>}{item.pending ? "届けた・まだ読まれていない" : timeOf(item.at)}</div>
        <div className="b"><Markdown text={item.text} /></div>
      </div>
    );
  }
  return (
    <div className="msg kid">
      <div className="mini-av"><Avatar pick={agent.avatar} seed={agent.id} mood="idle" role={roleOf(lineageDepth)} size={32} /></div>
      <div>
        <div className="meta"><b>{agent.name}</b>{timeOf(item.at)}</div>
        <div className="b"><Markdown text={item.text} /></div>
      </div>
    </div>
  );
}

/** お手紙の相手（送り手か宛先）を町の一覧から引く。見つからなければ null */
function useLetterPeer(raw: string | null | undefined, name?: string | null): Agent | null {
  const town = useContext(TownCtx);
  const sid8 = raw?.match(/^[^/\s]+\/([0-9a-f]{8})/i)?.[1] ?? null;
  const id = resolve(raw, town) ?? resolve(sid8, town) ?? resolve(name, town);
  return (id && town.find((a) => a.id === id)) || null;
}

/**
 * 受け取ったお手紙。並びは普通の発言と同じ（顔、名前と時刻、吹き出し）で、吹き出しの色だけ肌色にする（2026-11-12 本人の指示）。
 * 顔は送り手のキャラ（町と同じ絵）。送り手が町にいなければ、名前から決まる仮の顔
 */
function LetterBubble({ item }: { item: ConvItem }) {
  const raw = item.letter?.fromRaw ?? null;
  const who = useLetterPeer(raw, item.letter?.fromName);
  const name = who?.name ?? item.letter?.fromName ?? raw?.match(/^[^/\s]+\/([0-9a-f]{8})/i)?.[1] ?? "別のセッション";
  return <LetterView pick={who?.avatar} seed={who?.id ?? name} role={who?.parent ? "child" : "parent"} name={name} at={item.at} text={item.text} />;
}

/** 送ったお手紙。このセッション自身の発言として出し、名前の行に宛先（→ 名前）を添える。吹き出しは肌色 */
function SentLetter({ item, agent, lineageDepth }: { item: ConvItem; agent: Agent; lineageDepth: number }) {
  const s = item.sent!;
  const who = useLetterPeer(s.to ?? null, s.to ?? null);
  const to = s.create ? "新しい子" : who?.name ?? (s.to ? String(s.to).replace(/^uds:.*\/(\d+)\.sock$/, "pid $1") : "相手");
  return <LetterView pick={agent.avatar} seed={agent.id} role={roleOf(lineageDepth)} name={agent.name} to={`→ ${to}${s.peer ? `（${s.peer}）` : ""}`} at={item.at} text={s.text || s.summary || ""} />;
}

type LetterViewProps = { pick?: Agent["avatar"]; seed: string; role: Role; name: string; to?: string; at?: string | number | null; text: string };

/**
 * お手紙の吹き出しの見た目。お手紙の相手は町の一覧（TownCtx）から引くので、一覧を取るたびに上の2つは描き直される。
 * 見た目に使う値が変わらなければ、ここで止める（#10）
 */
const LetterView = memo(function LetterView({ pick, seed, role, name, to, at, text }: LetterViewProps) {
  chatPerf.bubble++;
  return (
    <div className="msg kid letter">
      <div className="mini-av"><Avatar pick={pick} seed={seed} mood="idle" role={role} size={32} /></div>
      <div>
        <div className="meta"><b>{name}</b>{to && <span className="to">{to}</span>}{timeOf(at)}</div>
        <div className="b"><Markdown text={text} /></div>
      </div>
    </div>
  );
}, (a, b) => a.seed === b.seed && a.role === b.role && a.name === b.name && a.to === b.to && a.at === b.at && a.text === b.text
  && a.pick?.char === b.pick?.char && a.pick?.hue === b.pick?.hue);

function fromLabel(from: string): string {
  // "from agent:<名前> via <ノード>" / "from local via <ノード>" / "from <メール> via <ノード>"
  const m = from.match(/^from (\S+) via (\S+)/);
  if (!m) return from;
  if (m[1] === "local") return "このアプリから";
  if (m[1].startsWith("agent:")) return `${m[1].slice(6)} から`;
  return `${m[2]} から`;
}
