import { useCallback, useRef, useState } from "react";
import type { Agent } from "../model";
import { perfStart } from "../term/perf";

/**
 * 右パネルに出す子の選択。選んでいる ID と、作った直後の仮の姿（fresh）、
 * 右パネルへの「端末を開く」「チャットを開く」「入力欄にフォーカス」の合図（termReq、chatReq、composeReq）を持つ
 */
export function useSelection() {
  const [selected, setSelected] = useState<string | null>(null);
  // 後継が立つまでの間に本人がほかを選んだら、選択を後継へ移さない。待った後の値を読むので ref で持つ
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  // 作った直後のセッション。一覧（snapshot）に載るまでは、create の応答から作った仮の姿で右パネルを出す（#18）。
  // 一覧の取り直しを待つと、ccn が遅いときにその分だけ右パネルが出ない
  const [fresh, setFresh] = useState<Agent | null>(null);
  // 右クリックや「端末へ」で、その子を選んで右パネルの端末を開く
  const [termReq, setTermReq] = useState(0);
  // お便りの「チャットへ」で、その子を選んで右パネルのチャットを開く
  const [chatReq, setChatReq] = useState(0);
  // 新しい世帯を作ったとき、右パネルのチャットを開いて入力欄にフォーカスする
  const [composeReq, setComposeReq] = useState(0);
  const focus = useCallback((a: Agent) => { perfStart("open", a.id); setSelected(a.id); setTermReq((n) => n + 1); }, []);
  return { selected, setSelected, selectedNow, fresh, setFresh, termReq, setTermReq, chatReq, setChatReq, composeReq, setComposeReq, focus };
}
