import { useEffect } from "react";
import { Power } from "lucide-react";
import type { Agent } from "../model";
import type { KillPlan } from "../killPlan";
import { ICON, STROKE } from "../icons";

/** セッションを止める操作の前の確認。Enter で進める、Esc でやめる。ok は進めるボタンの名前。single なら、やめるボタンを出さない（読んで閉じるだけの知らせ） */
export function Confirm({ title, ok, danger, single, onCancel, onConfirm, children }: { title: string; ok: string; danger?: boolean; single?: boolean; onCancel: () => void; onConfirm: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCancel, onConfirm]);
  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <p className="hint">{children}</p>
        <div className="modal-btns">
          {!single && <button className="pane-btn" onClick={onCancel}>やめる（Esc）</button>}
          <button className={danger ? "danger" : "primary"} autoFocus onClick={onConfirm}>{ok}（Enter）</button>
        </div>
      </div>
    </div>
  );
}

/** 閉じる前の確認。人数は killPlan で数える（#183）。sub-agent と in-process のチームメイトは親と一緒に終わる分として数え、外で起動した分は数えない */
export function KillConfirm({ agent, plan, onCancel, onConfirm }: { agent: Agent; plan: KillPlan; onCancel: () => void; onConfirm: () => void }) {
  const descendants = plan.descendants;
  // 止める子孫の数を引いた残りが、親と一緒に終わる sub-agent とチームメイト
  const riding = descendants - (plan.stop.length - 1);
  return (
    <Confirm title={`${agent.name}${descendants ? ` と子孫 ${descendants} 人` : ""}を閉じる？`} ok="閉じる" danger onCancel={onCancel} onConfirm={onConfirm}>
      このアプリが立てた claude を止める。{plan.stop.length > 1 ? "子孫は孫から順に止める。" : ""}{riding > 0 ? "sub-agent とチームメイトは親と一緒に終わる。" : ""}Claude Town の外で起動したセッションと、止まらなかった分は画面に残る。⌘ を押しながら閉じるボタン（<Power className="inline-icon" size={ICON.sm} strokeWidth={STROKE} aria-label="閉じる" />）を押すと、確認なしで閉じる。
    </Confirm>
  );
}
