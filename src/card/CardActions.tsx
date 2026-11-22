import { memo, useContext, useEffect, useRef, useState } from "react";
import { MessageCircleQuestionMark, Power, ThumbsUp, type LucideIcon } from "lucide-react";
import { ICON, STROKE } from "../icons";
import type { Agent } from "../model";
import { KillCtx, SendCtx } from "../contexts";
import { canStop as abilityStop } from "../abilities";

/**
 * カードの右下のボタン（#63）。左から並べる順に書く。送る文を足し替えるときはここだけを直す。
 * 右パネルの見出しにも、同じ定義から同じボタンを並べる（CardActions の place）。
 * kind が kill のボタンはセッションを閉じる（前のカードの × と同じ動き）。send のボタンは text をチャットの送信と同じ口で送る。
 * 見本は本人のスクショ（2026-11-13）。角丸のカードの右下の縁に、角丸の四角いボタンが縁にまたがって並ぶ
 */
export type CardAction = { key: string; icon: LucideIcon; name: string } & ({ kind: "kill" } | { kind: "send"; text: string });

const CARD_ACTIONS: CardAction[] = [
  { key: "kill", icon: Power, name: "閉じる", kind: "kill" },
  { key: "howdy", icon: MessageCircleQuestionMark, name: "様子を聞く", kind: "send", text: "調子どうですか" },
  { key: "go", icon: ThumbsUp, name: "許可する", kind: "send", text: "許可します、やってくださいお願いします。" },
];

/** true ならカードの右下のボタンをいつも出す。false ならカードに乗せたときと、選んでいるカードだけに出す */
const CARD_ACTIONS_ALWAYS = false;

/** 押したあとの反応（ボタンの一瞬の変化）の長さ（ms）。CSS の card-act-* と合わせる */
const CARD_ACT_FLASH_MS = 700;

/**
 * カードの右下のボタン（#63）。並びと送る文は CARD_ACTIONS で決める。出し入れは CSS（.fnode:hover と .fnode.open）で行い、描き直さない。
 * 押してもカードの選択や右パネルの切り替えが起きないよう、クリックはここで止める。
 * place が head なら、右パネルの見出しに、いつも見える形で並べる（動きはカードと同じ）。
 * ボタンに乗せたときの説明は title で出す（WebView の標準のツールチップ）。押せるときは何をするか、押せないときは押せない理由を書く
 */
export const CardActions = memo(function CardActions({ agent, place = "card" }: { agent: Agent; place?: "card" | "head" }) {
  const kill = useContext(KillCtx);
  const send = useContext(SendCtx);
  // 押したあとの一瞬の反応。key は押したボタン、ok は届いたか
  const [flash, setFlash] = useState<{ key: string; ok: boolean } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const canSend = agent.canSend;
  const canStop = abilityStop(agent);
  const press = async (act: CardAction, e: React.MouseEvent) => {
    e.stopPropagation();
    if (act.kind === "kill") { if (canStop) kill.ask(agent, e.metaKey); return; }
    if (!canSend || sending) return;
    setSending(act.key);
    const ok = await send(agent, act.text);
    setSending(null);
    setFlash({ key: act.key, ok });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), CARD_ACT_FLASH_MS);
  };
  return (
    <div className={`card-acts ${place === "head" ? "in-head" : CARD_ACTIONS_ALWAYS ? "always" : ""}`}
      onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {CARD_ACTIONS.map((act) => {
        const off = act.kind === "kill" ? !canStop : !canSend;
        const title = act.kind === "kill"
          ? (canStop ? `${act.name}: このセッションを止める。子孫がいれば一緒に止める（⌘ を押しながらで確認なし）` : "閉じられない: Claude Town の外で起動したセッション")
          : (canSend ? `${act.name}: 「${act.text}」を送る` : `${act.name}を送れない: Claude Town の外で起動したセッション`);
        const fx = flash?.key === act.key ? (flash.ok ? "sent" : "failed") : sending === act.key ? "sending" : "";
        return (
          <button key={act.key} type="button" className={`card-act ca-${act.key} ${off ? "off" : ""} ${fx}`}
            aria-disabled={off} title={title} aria-label={`${agent.name}: ${title}`}
            onClick={(e) => press(act, e)}>
            <act.icon size={place === "head" ? ICON.sm : ICON.xs} strokeWidth={STROKE} aria-hidden />
          </button>
        );
      })}
    </div>
  );
});
