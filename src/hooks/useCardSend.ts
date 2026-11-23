import { useCallback, useRef } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { kickTown } from "../town";
import { doneLog } from "../panel/bootDone";
import { sendVia } from "../session/sendVia";
import { isSlashCommand } from "../composer/edit";

/**
 * カードのボタンから文を送る（#63）。選んでいるセッションなら、右パネルの送信（仮の吹き出しと会話の取り直し）に任せる。
 * ほかのセッションは右パネルと同じ命令で送り（アプリの端末は入力欄へ貼る、外で起動したセッションは受信ソケット、ブラウザ版の ccn の行は send_message）、トーストを出す。参照を変えないよう ref を通し、町を描き直させない（#10）。
 * panelSend は Panel が自分の送信を登録する口
 */
export function useCardSend(toast: (text: string, bad?: boolean) => void) {
  const panelSend = useRef<((id: string, text: string) => Promise<boolean> | null) | null>(null);
  const sendImpl = useRef<(a: Agent, text: string) => Promise<boolean>>(async () => false);
  sendImpl.current = async (a, text) => {
    const viaPanel = panelSend.current?.(a.id, text);
    if (viaPanel) return viaPanel;
    try {
      // 送る命令は右パネルと同じ分け方で選ぶ（#225、session/sendVia.ts）。Claude Town の外で起動したセッションは send_direct で受信ソケットへ
      const via = sendVia(a, !(text.startsWith("!") || isSlashCommand(text)));
      if (via !== "send_or_queue") await invoke(via, { sessionId: a.id, text });
      else {
        // 起動前なら Rust が預かり、起動したら送る（composer.rs の send_or_queue）。送れなかったら App の見張りが知らせる（#184）
        const r = await invoke<{ queued?: boolean } | null>("send_or_queue", { sessionId: a.id, text });
        if (r?.queued) { doneLog.watch(a.id, a.name); toast(`${a.name} は起動中。起動したら届ける`); return true; }
      }
      kickTown();
      toast(`${a.name} に届けた`);
      return true;
    } catch (e) {
      toast(`${a.name} に届かなかった: ${e}`, true);
      return false;
    }
  };
  const cardSend = useCallback((a: Agent, text: string) => sendImpl.current(a, text), []);
  return { panelSend, cardSend };
}
