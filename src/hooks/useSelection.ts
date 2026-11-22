import { useCallback, useState } from "react";
import type { Agent } from "../model";
import { perfStart } from "../term/perf";

/**
 * 右パネルに出す子の選択。選んでいる ID と、作った直後の仮の姿（fresh）、
 * 右パネルへの「端末を開く」「チャットを開く」「入力欄にフォーカス」の合図（termReq、chatReq、composeReq）を持つ
 */
export function useSelection() {
  const [selected, setSelected] = useState<string | null>(null);
  // 作った直後のセッション。一覧（snapshot）に載るまでは、create の応答から作った仮の姿で右パネルを出す（#18）
  const [fresh, setFresh] = useState<Agent | null>(null);
  // 右クリックや「端末へ」で、その子を選んで右パネルの端末を開く
  const [termReq, setTermReq] = useState(0);
  // お便りの「チャットへ」で、その子を選んで右パネルのチャットを開く
  const [chatReq, setChatReq] = useState(0);
  // 新しい世帯を作ったとき、右パネルのチャットを開いて入力欄にフォーカスする
  const [composeReq, setComposeReq] = useState(0);
  const focus = useCallback((a: Agent) => { perfStart("open", a.id); setSelected(a.id); setTermReq((n) => n + 1); }, []);
  return { selected, setSelected, fresh, setFresh, termReq, setTermReq, chatReq, setChatReq, composeReq, setComposeReq, focus };
}
