import { useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent, ConvItem } from "../model";
import type { PendingItem } from "../conv";
import { commandError, routeOf } from "../composer/route";
import { isHttp, noRoute, viaCcn } from "../session/control";
import { BUILTINS, opensDialog } from "../composer/commands";
import { isSlashCommand } from "../composer/edit";
import type { useNodeSupport } from "../session/SessionControls";

type Opts = {
  agent: Agent | null; peer: string; hasTerm: boolean; items: ConvItem[]; switching: boolean;
  support: ReturnType<typeof useNodeSupport>[0]; markNoSupport: () => void;
  addNote: (sid: string, n: PendingItem) => void; setTab: (t: "term" | "talk" | "state") => void;
  setPending: React.Dispatch<React.SetStateAction<PendingItem[]>>; setText: (v: string) => void;
  stick: React.MutableRefObject<boolean>; convKick: React.MutableRefObject<() => void>;
  onSent: (a: Agent) => void; onError: (m: string) => void;
};

/** パネルからの送信。send は毎回の描画で作り直す（busy や items を読むため）。agent が無いときは何も送らない */
export function usePanelSend({ agent, peer, hasTerm, items, switching, support, markNoSupport, addNote, setTab, setPending, setText, stick, convKick, onSent, onError }: Opts) {
  const [busy, setBusy] = useState(false);
  /** quick はカードのボタンから送るとき。入力欄の下書きは消さない */
  const send = async (body: string, quick = false) => {
    if (!agent || !body.trim() || busy || switching) return false;
    // / で始まる組み込みのコマンドの振り分け（#97、src/composer/route.ts）。使えないものは送らずに理由を出す
    // ccn を通さないセッション（#96）は端末のセッションと同じく振り分けない（送る口のほうが断る）
    const route = routeOf(body, viaCcn(agent) ? agent.kind : "terminal", support);
    if (route?.kind === "blocked") { onError(route.reason); return false; }
    setBusy(true);
    const after = items[items.length - 1]?.n ?? -1;
    // 先頭が / か ! の文は、端末のあるセッションなら入力欄へ直接貼る。ccn の send_message は from の1行を前に付けるので、
    // CLI のコマンドやシェルモードとして動かない（docs/research/cli-input.md）
    const direct = hasTerm && (body.startsWith("!") || isSlashCommand(body));
    try {
      if (route?.kind === "command") {
        const r = await invoke<unknown>("run_command", { sessionId: agent.id, text: route.text, peer: peer || null });
        if (!isHttp(r)) throw new Error("ccn の応答が読めなかった");
        const err = commandError(r);
        if (err) {
          if (noRoute(r)) markNoSupport();
          throw new Error(err);
        }
        addNote(agent.id, { role: "event", kind: "command", text: `/${route.name} を実行した${route.note ? `。${route.note}` : ""}`, at: new Date().toISOString(), after });
      } else if (direct) {
        await invoke("send_direct", { sessionId: agent.id, text: body, peer: peer || null });
        // 画面を開くコマンド（/model など）は、ターミナルで操作してもらう
        if (opensDialog(body, BUILTINS)) setTab("term");
      } else {
        await invoke("send_message", { sessionId: agent.id, text: body, peer: peer || null });
        setPending((p) => [...p, { role: "user", text: body, pending: true, at: new Date().toISOString(), after }]);
      }
      if (!quick) setText("");
      stick.current = true;
      // 返事が来るまでは間隔を縮めて取る（#5）
      convKick.current();
      onSent(agent);
      return true;
    } catch (e) {
      onError(`${agent.name} に届かなかった: ${e}`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, send };
}
