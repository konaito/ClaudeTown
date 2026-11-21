// チャット欄からモデルと権限モードを替えるときの決まり（#97）。画面は SessionControls.tsx。
// ccn の口の仕様は claude-code-nodes の docs/superpowers/specs/2026-11-21-session-control-for-town.md にある。
// - node（-p の子）は SDK で替えるので、いつでも受ける。ターンの途中で替えたときの効き方は ccn でも未確認
// - pty（ノードが端末で動かす対話の claude）は、待機中だけ受ける。同じ id で起動し直すので約3秒かかる（実測 2.9 秒）
// - terminal（人が端末で起動したセッション）は替えられない（ccn が 409 で断る）

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
 * 古いノードは口が無いので 404（{"error":"not found"}）。セッションが無いときも 404 だが、本文で見分けない（どちらも使えない）。
 * それ以外（中継の 502 など）は分からないので、あとで確かめ直す
 */
export function supportOf(r: unknown): Support {
  if (!isHttp(r)) return "unknown";
  if (r.status === 400 && r.body?.code === "not_command") return "yes";
  if (r.status === 409) return "yes";
  if (r.status === 404 || r.status === 405) return "no";
  return "unknown";
}

export function isHttp(r: unknown): r is Http {
  return !!r && typeof r === "object" && typeof (r as Http).status === "number";
}

/** 口が無いノードの文言。仕様で決めた言い方に合わせる */
export const NO_SUPPORT = "このノードでは使えません（ccn が古く、切り替えの口が無い）";

/**
 * 今は替えられない理由。替えられるなら null。
 * switching は、こちらが替えている最中（pty は起動し直しを待っている）
 */
export function lockReason(a: Pick<Agent, "kind" | "state">, support: Support, switching: boolean): string | null {
  if (a.kind === "terminal") return "端末で起動したセッションなので、ここからは替えられない";
  if (support === "no") return NO_SUPPORT;
  if (support === "unknown") return "このノードで使えるかを確かめている";
  if (switching) return a.kind === "pty" ? "起動し直している（約3秒）" : "替えている";
  // 承認の欄（ExitPlanMode の計画の確認を含む）に答える前にモードを替えると、承認で決まるモードと食い違う。node も含めて止める
  if (a.state === "waiting_permission") return "承認待ちの間は替えられない。先に承認の欄で答える";
  if (a.kind === "pty" && a.state !== "idle") return "作業中は替えられない。端末のセッションは待機中だけ替えられる（止めてから替える）";
  return null;
}

/** 理由のうち、画面にいつも出しておくもの（確かめている最中は出さない） */
export function showReason(reason: string | null, support: Support): boolean {
  return !!reason && support !== "unknown";
}

/** configure_session が断られたときの文言。成功（2xx）なら null */
export function configureError(r: Http): string | null {
  if (r.status >= 200 && r.status < 300) return null;
  const b = typeof r.body === "object" && r.body ? r.body : {};
  const msg = typeof b.error === "string" ? b.error : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  if (r.status === 404 || r.status === 405) return NO_SUPPORT;
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
