// チャット欄からモデルと権限モードを替えるときの決まり（#97）。画面は SessionControls.tsx。
// ccn の口の仕様は claude-code-nodes の docs/superpowers/specs/2026-11-21-session-control-for-town.md にある。
// 選択はいつでも押せる。今は替えられなければ予約し、替えられるようになったら替える（always-switch）。
// - app（このアプリが PTY で立てた claude）: 端末に /model と Shift+Tab を書く（src-tauri/src/switch.rs）。予約も Rust が持つ。
//   モデルは作業中でもすぐ効く。承認待ちだけ待つ。モードは待機中に替える（作業中と承認待ちは予約）
// - ccn（ブラウザ版の ccn の行）: node（-p の子）は SDK で替えるので、承認待ちのほかはいつでも受ける。
//   pty（ノードが端末で動かす対話の claude）は、待機中だけ受ける。同じ id で起動し直すので約3秒かかる（実測 2.9 秒）。予約は画面が持つ（reserve.ts）
// - none（端末で起動したセッション、記録から読むだけのセッション、チームメイト、sub-agent）: 外から届ける口が無い。代わりの手を出す

import type { Agent } from "../model";

/** Rust の session_controls と configure_session が返す形。HTTP の応答をそのまま渡す */
export type Http = { status: number; body: any };

/** 候補は仕様書にある別名だけにする。今の値が別名でなければ（node は claude-sonnet-5-5 のような id で返る）、その値も選択肢に出す */
export const MODELS: { value: string; label: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/** ccn が受ける権限モード（PERMISSION_MODES）。並びは CLI の Shift+Tab の順に寄せ、残りを後ろに置いた */
export const MODES: { value: string; label: string; title: string }[] = [
  { value: "default", label: "default", title: "道具を使う前に承認を求める" },
  { value: "acceptEdits", label: "acceptEdits", title: "ファイルの編集は承認なしで進める" },
  { value: "plan", label: "plan", title: "計画だけを立てる。進める前に計画の確認（承認の欄）が出る" },
  { value: "auto", label: "auto", title: "承認の要否を Claude Code が判断する" },
  { value: "dontAsk", label: "dontAsk", title: "許可の決まりに無い道具は、聞かずに断る" },
  { value: "bypassPermissions", label: "bypassPermissions", title: "承認を全部飛ばす" },
];

export type Support = "unknown" | "yes" | "no";

/**
 * session_controls（空の文で command の口を叩いた応答）から、ノードに口があるかを決める。
 * 新しいノードは 400（code: not_command）で断る。終わったセッションなら 409 になるが、409 を返すのは新しいコードだけ。
 * 古いノードは口が無いので 404 の {"error":"not found"}（2026-11-21、本番の 4323 で実測）。
 * 新しいノードでもセッションが無ければ 404 になるが、本文は {"error":"unknown session"}（ccn の must()）なので、ノードの印にしない。
 * それ以外（中継の 502 など）は分からないので、あとで確かめ直す
 */
export function supportOf(r: unknown): Support {
  if (!isHttp(r)) return "unknown";
  if (r.status === 400 && r.body?.code === "not_command") return "yes";
  if (r.status === 409) return "yes";
  if (noRoute(r)) return "no";
  return "unknown";
}

/** 口そのものが無い（古いノード）。セッションが無い 404 とは本文で見分ける */
export function noRoute(r: Http): boolean {
  return r.status === 405 || (r.status === 404 && r.body?.error === "not found");
}

export function isHttp(r: unknown): r is Http {
  return !!r && typeof r === "object" && typeof (r as Http).status === "number";
}

/** 口が無いノードの文言。仕様で決めた言い方に合わせる */
export const NO_SUPPORT = "このノードでは使えません（ccn が古く、切り替えの口が無い）";

/** どの口で替えるか。app はこのアプリが PTY で立てた claude（端末に /model と Shift+Tab を書く、src-tauri/src/switch.rs）。
 *  ccn はブラウザ版（PWA）の ccn の行（ccn の PATCH）。none は外から届ける口が無いセッション */
export type Route = "app" | "ccn" | "none";

export function routeOf(a: Pick<Agent, "kind" | "source" | "capabilities">): Route {
  if (a.source === "app" && a.capabilities?.terminal) return "app";
  if (viaCcn(a) && a.kind !== "terminal") return "ccn";
  return "none";
}

export type What = "model" | "mode";

/**
 * 選んだ値をいつ当てるか。now はすぐ、wait は予約して when の時点で当てる、none は当てる口が無い（why に代わりの手を書く）。
 * 選択はどの場合も押せる。none のときは、選んだら why を出す
 */
export type Plan = { kind: "now" } | { kind: "wait"; when: string } | { kind: "none"; why: string };

/** Shift+Tab の順に出ないので、端末に書いても届かないモード（2026-11-21、v2.1.330 で確かめた） */
export const UNREACHABLE_MODES = ["dontAsk"];

/**
 * switching は、こちらが替えている最中（ccn の pty は起動し直しを待っている）。
 * 承認の欄（ExitPlanMode の計画の確認を含む）が出ている間は、どの口も待つ。
 * app は端末に書くので、承認の画面に入力が入る（Enter は許可になる）。ccn は承認で決まるモードと食い違う
 */
export function planOf(a: Pick<Agent, "kind" | "state" | "source" | "capabilities" | "name">, what: What, value: string | null, support: Support, switching: boolean): Plan {
  const route = routeOf(a);
  if (route === "none") return { kind: "none", why: noRouteWhy(a, what, value) };
  if (route === "app") {
    if (what === "mode" && value && UNREACHABLE_MODES.includes(value)) {
      return { kind: "none", why: `${value} は Shift+Tab の順に出ないので、端末からは替えられない。claude を --permission-mode ${value} で起動し直す` };
    }
    if (a.state === "waiting_permission") return { kind: "wait", when: "承認に答えたら替える" };
    // モードは Shift+Tab で順に回すので、途中のモード（bypassPermissions など）を通る。道具が走っている間には回さない
    if (what === "mode" && a.state !== "idle") return { kind: "wait", when: "このターンが終わったら替える" };
    return { kind: "now" };
  }
  if (support === "no") return { kind: "none", why: NO_SUPPORT };
  if (support === "unknown") return { kind: "wait", when: "このノードで使えるかを確かめてから替える" };
  if (switching) return { kind: "wait", when: "いまの切り替えが終わったら替える" };
  if (a.state === "waiting_permission") return { kind: "wait", when: "承認に答えたら替える" };
  if (a.kind === "pty" && a.state !== "idle") return { kind: "wait", when: "このターンが終わったら替える（端末のセッションは claude を起動し直す）" };
  return { kind: "now" };
}

/** 外から届ける口が無いセッションで、代わりにできること。Claude Code に外から入力やモデルを渡す口は無い（README の「モデルと権限モード」） */
export function noRouteWhy(a: Pick<Agent, "kind" | "source">, what: What, value: string | null): string {
  const v = value ?? (what === "model" ? "<モデル>" : "<モード>");
  const inTerm = what === "model" ? `/model ${v} を打つ` : v === "plan" ? "/plan を打つか、Shift+Tab で plan にする" : `Shift+Tab で ${v} にする`;
  if (a.kind === "subagent") return "sub-agent は親のセッションの中で動くので、ここからは替えられない";
  if (a.kind === "teammate") {
    return what === "model"
      ? "チームメイトのモデルは起動のときに決まり、後から替えられない（Claude Code の仕様）"
      : `チームメイトの権限モードは、リードの端末でそのチームメイトを開き、Shift+Tab で ${v} にする（次のターンから効く）`;
  }
  if (viaCcn(a)) return `端末で起動したセッションには、ccn から替える口が無い。そのターミナルで ${inTerm}`;
  return `Claude Town の外で起動したセッションには、外から入力を届ける口が無い。起動したターミナルで ${inTerm}`;
}

/** ccn が動かしているセッションか。ブラウザ版（PWA）が ccn から読む行だけで、アプリ（Tauri）の行はどれも当たらない */
export function viaCcn(a: Pick<Agent, "kind" | "source">): boolean {
  return a.source === "ccn";
}

/** configure_session が断られたときの文言。成功（2xx）なら null */
export function configureError(r: Http): string | null {
  if (r.status >= 200 && r.status < 300) return null;
  const b = typeof r.body === "object" && r.body ? r.body : {};
  const msg = typeof b.error === "string" ? b.error : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  if (noRoute(r)) return NO_SUPPORT;
  if (r.status === 404) return "セッションが見つからなかった（終わったか、別のノードに移った）";
  if (r.status === 400) return `ccn が値を受け付けなかった: ${msg}`;
  if (r.status === 409 && b.code === "busy") return "作業中か承認待ちなので替えられなかった。終わるのを待つか、止めてから替える";
  if (r.status === 409 && b.hint === "resume") return "セッションが終わっているので替えられなかった";
  if (r.status === 409) return `このセッションでは替えられない（${b.kind ?? msg}）`;
  if (r.status === 502 && b.code === "restart_failed") {
    return b.rolledBack ? "新しい設定で claude が起動しなかったので、前の設定に戻した" : "新しい設定で claude が起動しなかった。ターミナルで様子を見る";
  }
  return `ccn が ${r.status} を返した: ${msg}`;
}

/** モデルの選択肢。今の値が候補の別名でなければ先頭に足す */
export function modelOptions(current: string | null | undefined): { value: string; label: string }[] {
  if (!current || MODELS.some((m) => m.value === current)) return MODELS;
  // 幅が狭いので、表示だけ claude- を外す（値はそのまま）
  return [{ value: current, label: current.replace(/^claude-/, "") }, ...MODELS];
}

/** 権限モードの選択肢。今の値が候補に無ければ（新しいモードなど）先頭に足す */
export function modeOptions(current: string | null | undefined): { value: string; label: string; title: string }[] {
  if (!current || MODES.some((m) => m.value === current)) return MODES;
  return [{ value: current, label: current, title: current }, ...MODES];
}
