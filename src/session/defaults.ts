// 新しい世帯を立てるときのモデル、権限モード、effort の既定（設定の画面で決める）。
// 立てるときに create_session へ model、permissionMode、effort を渡し、claude を --model、--permission-mode、--effort で起動させる（src-tauri/src/pty.rs の start_args）。
// ブラウザ版（ccn の POST /api/sessions）は effort を受けないので、effort は渡さない（src/bridge.ts）。
// 立った後の送信先の行のセレクト（SessionControls）はセッションの実際の値を読むので、まだチャットが無い段階でもこの値が出る。
// 送信先の行で選び直したら、そのセッションでは選んだ値が効く（configure_session）。
// 既定が効くのは、この画面から立てる新しい世帯だけ。引き継ぎ（resume と fork）は ccn が前任の値を継ぐので渡さない。
// 保存先は localStorage（新しい世帯の場所 claude-town.newHousePlace と同じ）。null は「設定しない」で、渡さず、この Mac の Claude Code の既定で立つ。
// effort の無い古い保存は、effort を設定しないとして読む。
import { EFFORTS, MODELS, MODES } from "./control";

export const DEFAULTS_KEY = "claude-town.sessionDefaults";

export type SessionDefaults = { model: string | null; permissionMode: string | null; effort: string | null };
export const NO_DEFAULTS: SessionDefaults = { model: null, permissionMode: null, effort: null };

const pick = (v: unknown, ok: { value: string }[]) => (typeof v === "string" && ok.some((o) => o.value === v) ? v : null);

/** 候補（MODELS、MODES、EFFORTS）に無い値は設定なしとして読む */
export function parseDefaults(raw: string | null): SessionDefaults {
  if (!raw) return NO_DEFAULTS;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return NO_DEFAULTS;
    return { model: pick(v.model, MODELS), permissionMode: pick(v.permissionMode, MODES), effort: pick(v.effort, EFFORTS) };
  } catch { return NO_DEFAULTS; }
}

export function loadDefaults(): SessionDefaults {
  try { return parseDefaults(localStorage.getItem(DEFAULTS_KEY)); } catch { return NO_DEFAULTS; }
}

/** 全部 null なら消す。保存できなくても動きは変えない */
export function saveDefaults(d: SessionDefaults) {
  try {
    if (!d.model && !d.permissionMode && !d.effort) localStorage.removeItem(DEFAULTS_KEY);
    else localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
  } catch { /* 保存できなくても動きは変えない */ }
}

export function sameDefaults(a: SessionDefaults, b: SessionDefaults): boolean {
  return a.model === b.model && a.permissionMode === b.permissionMode && a.effort === b.effort;
}
