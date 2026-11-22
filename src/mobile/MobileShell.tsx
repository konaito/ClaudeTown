// スマホ専用の画面。1画面1役にする。一覧（町の世帯と子、状態の色）から子を押すと、チャットが全画面で開く。戻るで一覧へ。
// 取得・選択・送信の状態は App が持ち、ここは並べ方だけを持つ（Panel も App が作って渡す）。
import { useEffect, type ReactNode } from "react";
import { Avatar, roleOf } from "../kid/Avatar";
import type { Mail } from "../mail";
import { MOOD_LABEL, houseNameOf, moodOf, nowOf, taskOf, type Agent, type Mood, type Snapshot } from "../model";

type Tree = { byId: Map<string, Agent>; childrenOf: Map<string, Agent[]>; families: { root: Agent; all: Agent[] }[] };

type Props = {
  tree: Tree;
  snap: Snapshot | null;
  /** 一覧を読めなかった理由（ブラウザ版で ccn に届かないときなど） */
  err: string | null;
  counts: Record<Mood, number>;
  total: number;
  /** いま開いているチャット。無ければ一覧を出す */
  open: Agent | null;
  mails: Mail[];
  onPick: (a: Agent) => void;
  onMail: (m: Mail) => void;
  onBack: () => void;
  /** チャットの中身（Panel）。一覧の裏でも作ったままにし、打ちかけの文を戻っても残す */
  chat: (back: () => void) => ReactNode;
};

/** 世帯の中を、親から順に、深さつきで並べる */
function flatten(root: Agent, kids: Map<string, Agent[]>): { a: Agent; depth: number }[] {
  const out: { a: Agent; depth: number }[] = [];
  const walk = (a: Agent, depth: number) => { out.push({ a, depth }); for (const k of kids.get(a.id) ?? []) walk(k, depth + 1); };
  walk(root, 0);
  return out;
}

function Row({ a, depth, onPick, mood }: { a: Agent; depth: number; onPick: (a: Agent) => void; mood?: Mood }) {
  const m = mood ?? moodOf(a);
  const line = m === "working" ? nowOf(a, m) ?? taskOf(a, m) : taskOf(a, m);
  return (
    <button className={`mr m-${m}`} style={{ paddingLeft: 16 + Math.min(depth, 3) * 20 }} onClick={() => onPick(a)}>
      <span className="mr-av"><Avatar pick={a.avatar} seed={a.id} mood={m} role={roleOf(depth)} size={40} /></span>
      <span className="mr-body">
        <span className="mr-name">{a.name}</span>
        <span className="mr-line">{line}</span>
      </span>
      <span className={`mr-st st st-${m}`}><i />{MOOD_LABEL[m]}</span>
    </button>
  );
}

export function MobileShell(p: Props) {
  // 戻る操作（端末の戻るボタン、スワイプ）でチャットを閉じる。履歴を1つ積み、戻ったら閉じる。積まないと、ホーム画面のアプリでは戻る操作でアプリが終わる
  const isOpen = !!p.open;
  useEffect(() => {
    if (isOpen && !history.state?.mChat) history.pushState({ ...history.state, mChat: true }, "");
  }, [isOpen]);
  useEffect(() => {
    const on = (e: PopStateEvent) => { if (!e.state?.mChat) p.onBack(); };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, [p.onBack]);
  const back = () => { if (history.state?.mChat) history.back(); else p.onBack(); };

  const needs = p.mails.filter((m) => m.kind !== "done");

  return (
    <>
      <div className={`m-screen m-list${isOpen ? " away" : ""}`} aria-hidden={isOpen}>
        <header className="m-top">
          <h1>Claude Town</h1>
        </header>
        <div className="m-scroll">
          {p.err && <p className="m-note bad">{p.err}</p>}

          {needs.length > 0 && (
            <section>
              <h2 className="m-h need">あなたの番<b>{needs.length}</b></h2>
              {needs.map((m) => (
                <Row key={m.agent.id} a={m.agent} depth={m.root ? 0 : 1} mood={m.kind as Mood} onPick={() => p.onMail(m)} />
              ))}
            </section>
          )}

          <p className="m-sum">
            {p.tree.families.length}世帯・{p.total}人
            {(["working", "reply", "approval", "done", "idle"] as Mood[]).filter((k) => p.counts[k]).map((k) => (
              <span key={k} className={`lg lg-${k}`}><i />{MOOD_LABEL[k]} {p.counts[k]}</span>
            ))}
          </p>

          {p.snap && p.total === 0 && <p className="m-note">この町にはまだ誰もいません。</p>}
          {p.tree.families.map((f) => (
            <section key={f.root.id}>
              <h2 className="m-h">{houseNameOf(f.root)}<b>{f.all.length}人</b></h2>
              {flatten(f.root, p.tree.childrenOf).map(({ a, depth }) => <Row key={a.id} a={a} depth={depth} onPick={p.onPick} />)}
            </section>
          ))}
        </div>
      </div>

      <div className={`m-screen m-chat${isOpen ? "" : " away"}`} aria-hidden={!isOpen}>
        {p.chat(back)}
      </div>
    </>
  );
}
