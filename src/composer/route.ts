// チャット欄で / から始まる文をどこへ送るか（#97）。ccn の command の口（POST /api/sessions/<id>/command）は from 行を付けずに
// 入力として渡すので、組み込みコマンドが動く。口の仕様と実測は claude-code-nodes の docs/superpowers/specs/2026-11-21-session-control-for-town.md。
//
// - command: command の口へ送る。仕様書の表で効くと確かめた5つだけ（/compact、/clear、/context、/cost、/usage）
// - blocked: 送らずに「ここでは使えません」と理由を出す
// - legacy: 今までどおり（pty は端末の入力欄へ貼る、node は from 行付きの文として Claude に読ませる）
//
// 5つ以外の組み込みとスキルを legacy に残したのは、pty で今まで動いていたもの（/init、/rename、/code-review など）を止めないため（仮置き）。
// ただし、画面を開くものと設定に書くものは、チャットからは送らない。
import { BUILTINS, type Command } from "./commands";
import { isSlashCommand } from "./edit";
import type { Agent } from "../model";
import type { Support } from "../session/control";

/** command の口へ送るもの */
export const RUN = new Set(["compact", "clear", "context", "cost", "usage"]);

/** pty では画面を開いて止まるもの。2026-11-21 に開発用ノードで /cost を送ると、端末に Settings の Usage の画面が開いたままになり、
 * result の文は空だった（interrupt で閉じた）。/usage は /cost の元の名前なので同じ扱いにした（/usage そのものは pty で試していない） */
export const PTY_SCREEN = new Set(["cost", "usage"]);

/** 設定ファイルや機械全体の設定を替えるもの。ccn は pty の /effort と /fast だけを断り、ほかは断らない（仕様書）。
 * 説明（commands.ts の出所の文書）から、設定や鍵の割り当てを書きうるものを選んだ。書くかどうかを1つずつ確かめてはいない */
export const WRITES = new Set([
  "config", "effort", "fast", "output-style", "logout", "login", "theme", "import", "plugin", "keybindings", "terminal-setup",
  "statusline", "update-config", "auto-mode-setup", "privacy-settings", "tui", "advisor", "autocompact", "sandbox", "voice",
]);

export type Route =
  | { kind: "command"; name: string; text: string; note: string | null }
  | { kind: "blocked"; reason: string }
  | { kind: "legacy" };

export const NO_COMMANDS = "このノードでは使えません（ccn が古く、コマンドの口が無い）";

/** 組み込みのコマンドを名前か別名で引く */
export function builtinOf(name: string, list: Command[] = BUILTINS): Command | undefined {
  return list.find((c) => c.source === "builtin" && (c.name === name || c.aliases?.includes(name)));
}

export function routeOf(text: string, kind: Agent["kind"], support: Support): Route | null {
  const t = text.trim();
  if (!isSlashCommand(t)) return null;
  // 人が端末で起動したセッションには、ccn はコマンドを送れない（409 no_commands）。今までどおりにする
  if (kind === "terminal") return { kind: "legacy" };
  const m = /^\/(\S*)([\s\S]*)$/.exec(t)!;
  const c = builtinOf(m[1]);
  if (!c) return { kind: "legacy" };
  const name = c.name;
  const rest = m[2];
  const hasArg = rest.trim().length > 0;
  if (name === "model") {
    return { kind: "blocked", reason: support === "no" ? "/model はここでは使えません（このノードにはモデルの切り替えの口が無い）" :"/model はここでは使えません。送信先の行のモデルの切り替えを使う（/model は機械の全セッションの既定まで書き換える）" };
  }
  if (name === "exit") return { kind: "blocked", reason: `/${m[1]} はここでは使えません。止めるときは、止めるボタンを使う` };
  if (RUN.has(name)) {
    if (kind === "pty" && PTY_SCREEN.has(name)) return { kind: "blocked", reason: `/${m[1]} はここでは使えません。端末のセッションでは画面が開いて止まる（ターミナルのタブで打つ）` };
    if (support === "yes") return { kind: "command", name, text: `/${name}${rest}`, note: noteOf(name, kind) };
    // 古いノードの pty は、今までどおり端末の入力欄へ貼れば動く
    if (kind === "pty") return { kind: "legacy" };
    return { kind: "blocked", reason: support === "no" ? `/${m[1]} は${NO_COMMANDS}` : "このノードで使えるかを確かめている。少し待ってから送る" };
  }
  if (WRITES.has(name)) return { kind: "blocked", reason: `/${m[1]} はここでは使えません。設定を替えるコマンドなので、チャットからは送らない（ターミナルのタブで打つ）` };
  if (c.dialog === true || (c.dialog === "noarg" && !hasArg)) {
    return { kind: "blocked", reason: `/${m[1]}${c.dialog === "noarg" ? "（引数なし）" : ""} はここでは使えません。画面を開くコマンドなので、ターミナルのタブで打つ` };
  }
  return { kind: "legacy" };
}

/** 実行した後に会話へ出す一言 */
export function noteOf(name: string, kind: Agent["kind"]): string | null {
  if (name === "context" && kind === "pty") return "出力は端末にだけ出る。ターミナルのタブで見る";
  if (name === "compact") return "要約が終わるまで作業中になる";
  if (name === "clear") return "ここから新しい会話になる";
  return null;
}

/** 補完の候補に添える印。使えないものは「ここでは使えません」と分かるようにする */
export function tagOf(c: Command, kind: Agent["kind"], support: Support): { text: string; off: boolean; title: string } | null {
  if (c.source !== "builtin" || kind === "terminal") return null;
  const r = routeOf(`/${c.name}`, kind, support);
  if (!r) return null;
  if (r.kind === "command") return { text: r.note && kind === "pty" && c.name === "context" ? "実行・出力は端末" : "実行", off: false, title: "チャットからコマンドとして実行する" };
  if (r.kind === "blocked") {
    if (c.dialog === "noarg" && !WRITES.has(c.name) && c.name !== "model") return { text: "引数が要る", off: false, title: r.reason };
    return { text: "ここでは使えません", off: true, title: r.reason };
  }
  return null;
}

/** command の口が断ったときの文言。成功なら null */
export function commandError(r: { status: number; body: any }): string | null {
  if (r.status >= 200 && r.status < 300) return null;
  const b = typeof r.body === "object" && r.body ? r.body : {};
  const msg = typeof b.error === "string" ? b.error : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  if (r.status === 404 || r.status === 405) return NO_COMMANDS;
  switch (b.code) {
    case "use_configure": return "/model はここでは使えません。送信先の行のモデルの切り替えを使う";
    case "use_stop": return "止めるときは、止めるボタンを使う";
    case "first_message_required": return "まだ最初の文が届いていないので、コマンドを送れない。先に文を送る";
    case "persists": return "全セッションの設定に保存されるコマンドなので、ccn が断った";
    case "no_commands": return "端末で起動したセッションには、コマンドを送れない";
  }
  if (r.status === 409 && b.hint === "resume") return "セッションが終わっているので送れなかった";
  if (r.status === 409) return `送れなかった（${msg}）。承認待ちなら先に答える`;
  return `ccn が ${r.status} を返した: ${msg}`;
}
