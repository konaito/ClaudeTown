import { useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent, ConvItem } from "../model";
import type { PendingItem } from "../conv";
import { commandError, routeOf } from "../composer/route";
import { isHttp, noRoute, viaCcn } from "../session/control";
import { BUILTINS, opensDialog } from "../composer/commands";
import { isSlashCommand } from "../composer/edit";
import type { useNodeSupport } from "../session/SessionControls";

type Opts = {
  agent: Agent | null; hasTerm: boolean; items: ConvItem[]; switching: boolean;
  support: ReturnType<typeof useNodeSupport>[0]; markNoSupport: () => void;
  addNote: (sid: string, n: PendingItem) => void; setTab: (t: "term" | "talk" | "state") => void;
  /** 送った先のセッション id の仮の一覧に足す（#178） */
  addPending: (sid: string, item: PendingItem) => void; setText: (v: string) => void;
  stick: React.MutableRefObject<boolean>; convKick: React.MutableRefObject<() => void>;
  onSent: (a: Agent) => void; onError: (m: string) => void;
  /** 起動前に送って Rust が預かったとき（起動の見張りを読み直させる） */
  onQueued: () => void;
};

/** パネルからの送信。send は毎回の描画で作り直す（busy や items を読むため）。agent が無いときは何も送らない */
export function usePanelSend({ agent, hasTerm, items, switching, support, markNoSupport, addNote, setTab, addPending, setText, stick, convKick, onSent, onError, onQueued }: Opts) {
  const [busy, setBusy] = useState(false);
  // 今パネルで開いているセッション（#178）。await の間に別の子へ切り替えたら、送った先と違う
  const shownId = useRef(agent?.id);
  shownId.current = agent?.id;
  /** quick はカードのボタンから送るとき。入力欄の下書きは消さない */
  const send = async (body: string, quick = false) => {
    if (!agent || !body.trim() || busy || switching) return false;
    // / で始まる組み込みのコマンドの振り分け（#97、src/composer/route.ts）。使えないものは送らずに理由を出す。
    // ブラウザ版（PWA）の ccn の行のほかは、端末のセッションと同じく振り分けない
    const route = routeOf(body, viaCcn(agent) ? agent.kind : "terminal", support);
    if (route?.kind === "blocked") { onError(route.reason); return false; }
    setBusy(true);
    const to = agent.id;
    // タブ、一番下への送り、会話の取り直しは、送った先を開いたままのときだけ効かせる（#178）
    const here = () => shownId.current === to;
    const after = items[items.length - 1]?.n ?? -1;
    // アプリが立てたセッションは、どの文も端末の入力欄へ貼って Enter を押す（CLI に打ったのと同じ）。
    // ブラウザ版の ccn の行では、先頭が / か ! の文だけを入力欄へ貼る。ccn の send_message は from の1行を前に付けるので、
    // CLI のコマンドやシェルモードとして動かない（docs/research/cli-input.md）
    // Claude Town の外で起動したセッション（端末が無い）も send_direct に渡す。Rust が受信ソケットで送る（#156）
    const plain = !(body.startsWith("!") || isSlashCommand(body));
    const direct = !viaCcn(agent) || (hasTerm && !plain);
    // 起動前で Rust が預かったか。預かったときは「届けた」と言わない（会話の末尾に「起動したら送る」が出る）
    let queued = false;
    try {
      if (route?.kind === "command") {
        const r = await invoke<unknown>("run_command", { sessionId: agent.id, text: route.text });
        if (!isHttp(r)) throw new Error("ccn の応答が読めなかった");
        const err = commandError(r);
        if (err) {
          if (noRoute(r)) markNoSupport();
          throw new Error(err);
        }
        addNote(agent.id, { role: "event", kind: "command", text: `/${route.name} を実行した${route.note ? `。${route.note}` : ""}`, at: new Date().toISOString(), after });
      } else if (direct && !viaCcn(agent) && hasTerm) {
        // アプリが立てた端末: claude の起動前（信頼の確認の画面を含む）なら、Rust が預かって起動したら送る（composer.rs の send_or_queue）。
        // 預かった文は会話の末尾に「起動したら送る」として出す（Panel が boot_status から出す）
        const r = await invoke<{ queued?: boolean } | null>("send_or_queue", { sessionId: agent.id, text: body });
        queued = !!r?.queued;
        if (queued) onQueued();
        else {
          // 画面を開くコマンド（/model など）は、ターミナルで操作してもらう
          if (!plain && opensDialog(body, BUILTINS) && here()) setTab("term");
          if (plain) addPending(to, { role: "user", text: body, pending: true, at: new Date().toISOString(), after });
        }
      } else if (direct) {
        // ブラウザ版の ccn の行の / と ! の文と、Claude Town の外で起動したセッション（Rust が受信ソケットで送る、#156）
        await invoke("send_direct", { sessionId: agent.id, text: body });
        if (!plain && opensDialog(body, BUILTINS) && here()) setTab("term");
        if (plain && !viaCcn(agent)) addPending(to, { role: "user", text: body, pending: true, at: new Date().toISOString(), after });
      } else {
        await invoke("send_message", { sessionId: agent.id, text: body });
        addPending(to, { role: "user", text: body, pending: true, at: new Date().toISOString(), after });
      }
      if (!quick) setText("");
      if (here()) {
        stick.current = true;
        // 返事が来るまでは間隔を縮めて取る（#5）
        convKick.current();
      }
      if (!queued) onSent(agent);
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
