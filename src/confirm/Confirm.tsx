import { useEffect, useId, useRef } from "react";
import { Power } from "lucide-react";
import type { Agent } from "../model";
import type { KillPlan } from "../killPlan";
import { ICON, STROKE } from "../icons";
import { confirmKeyAction } from "./keys";

/** セッションを止める操作の前の確認。Enter で進める（フォーカスが「やめる」にあるときはやめる）、Esc でやめる。ok は進めるボタンの名前。single なら、やめるボタンを出さない（読んで閉じるだけの知らせ） */
export function Confirm({ title, ok, danger, single, onCancel, onConfirm, children }: { title: string; ok: string; danger?: boolean; single?: boolean; onCancel: () => void; onConfirm: () => void; children: React.ReactNode }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const act = confirmKeyAction(e.key, !!cancelRef.current && document.activeElement === cancelRef.current);
      if (!act) return;
      e.preventDefault();
      if (act === "cancel") onCancel(); else onConfirm();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCancel, onConfirm]);
  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title" id={titleId}>{title}</div>
        <p className="hint">{children}</p>
        <div className="modal-btns">
          {!single && <button ref={cancelRef} className="pane-btn" onClick={onCancel}>やめる（Esc）</button>}
          <button className={danger ? "danger" : "primary"} autoFocus onClick={onConfirm}>{ok}（Enter）</button>
        </div>
      </div>
    </div>
  );
}

/** 閉じる前の確認。人数は killPlan で数える（#183）。sub-agent と in-process のチームメイトは親と一緒に終わる分として数え、ここから止められない分（tmux のチームメイトなど）は数えない */
export function KillConfirm({ agent, plan, onCancel, onConfirm }: { agent: Agent; plan: KillPlan; onCancel: () => void; onConfirm: () => void }) {
  const descendants = plan.descendants;
  // 止める子孫の数を引いた残りが、親と一緒に終わる sub-agent とチームメイト
  const riding = descendants - (plan.stop.length - 1);
  return (
    <Confirm title={`${agent.name}${descendants ? ` と子孫 ${descendants} 人` : ""}を閉じる？`} ok="閉じる" danger onCancel={onCancel} onConfirm={onConfirm}>
      claude を止める。Claude Town の外で起動したものは、起動した端末がシェルに戻る。{plan.stop.length > 1 ? "子孫は孫から順に止める。" : ""}{riding > 0 ? "sub-agent とチームメイトは親と一緒に終わる。" : ""}tmux のチームメイトと、止まらなかった分は画面に残る。⌘ を押しながら閉じるボタン（<Power className="inline-icon" size={ICON.sm} strokeWidth={STROKE} aria-label="閉じる" />）を押すと、確認なしで閉じる。
    </Confirm>
  );
}
