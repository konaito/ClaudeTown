import { useCallback, useRef } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { kickTown } from "../town";

/**
 * カードのボタンから文を送る（#63）。選んでいるセッションなら、右パネルの送信（仮の吹き出しと会話の取り直し）に任せる。
 * ほかのセッションは send_message で送り、トーストを出す。参照を変えないよう ref を通し、町を描き直させない（#10）。
 * panelSend は Panel が自分の送信を登録する口
 */
export function useCardSend(peer: string, toast: (text: string, bad?: boolean) => void) {
  const panelSend = useRef<((id: string, text: string) => Promise<boolean> | null) | null>(null);
  const sendImpl = useRef<(a: Agent, text: string) => Promise<boolean>>(async () => false);
  sendImpl.current = async (a, text) => {
    const viaPanel = panelSend.current?.(a.id, text);
    if (viaPanel) return viaPanel;
    try {
      await invoke("send_message", { sessionId: a.id, text, peer: peer || null });
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
