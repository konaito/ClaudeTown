import type { Agent } from "../model";
import { hasTerminal } from "../abilities";
import { viaCcn } from "./control";

export type SendCommand = "send_or_queue" | "send_direct" | "send_message";

/**
 * 文を送るときに呼ぶ Rust の命令を選ぶ（#225）。右パネルの送信（src/panel/usePanelSend.ts）と同じ分け方で、カードのボタンもこれを使う。
 * - アプリが立てた端末（端末を持つ行）は send_or_queue。claude の起動前なら Rust が預かり、起動したら送る
 * - Claude Town の外で起動したセッション（native の行）は send_direct。Rust が受信ソケットで送り（#156）、ソケットが無ければ理由を返して断る
 * - ブラウザ版（PWA）の ccn の行は send_message。ただし端末の行で先頭が / か ! の文（plain が false）は send_direct で入力欄へ貼る
 *   （ccn の send_message は from の1行を前に付けるので、CLI のコマンドとして動かない。docs/research/cli-input.md）
 * plain は、先頭が / のコマンドでも ! のシェルでもない文か
 */
export function sendVia(a: Pick<Agent, "kind" | "source" | "capabilities">, plain: boolean): SendCommand {
  const term = hasTerminal(a);
  if (viaCcn(a)) return term && !plain ? "send_direct" : "send_message";
  return term ? "send_or_queue" : "send_direct";
}
