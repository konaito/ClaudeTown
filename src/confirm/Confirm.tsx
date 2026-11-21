import { useEffect } from "react";
import type { Agent } from "../model";

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

/** 閉じる前の確認 */
export function KillConfirm({ agent, descendants, onCancel, onConfirm }: { agent: Agent; descendants: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm title={`${agent.name}${descendants ? ` と子孫 ${descendants} 人` : ""}を閉じる？`} ok="閉じる" danger onCancel={onCancel} onConfirm={onConfirm}>
      ccn でセッションを止める。{descendants ? "子孫は孫から順に止める。" : ""}止まらなかった分は画面に残る。⌘ を押しながら 🐺 を押すと、確認なしで閉じる。
    </Confirm>
  );
}

/** 引き継ぐ前の確認。前任を止める操作を含むので、閉じるときと同じ形で確かめる。parent は前任の親（根なら null）、kids は前任の子の数 */
export function SucceedConfirm({ agent, parent, kids, onCancel, onConfirm }: { agent: Agent; parent: Agent | null; kids: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm title={`${agent.name} を後継に引き継ぐ？`} ok="引き継ぐ" onCancel={onCancel} onConfirm={onConfirm}>
      利用上限で止まったときに使う。同じ会話を複製した後継を、{parent ? `${parent.name} の下に` : "世帯の親として"}立てる。アカウントは ccn が枠の残るものを選ぶ。
      後継が起動したのを確かめてから、{agent.name} を止める。後継が立たなかったら止めない。
      {kids ? `子 ${kids} 人は止めない。ccn が子を後継の下に付け替える（古い ccn では付け替わらず、子は別の世帯に分かれる）。` : ""}
    </Confirm>
  );
}
