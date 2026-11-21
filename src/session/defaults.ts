// 新しい世帯を立てるときのモデルと権限モードの既定（設定の画面で決める）。
// 立てるときに ccn の POST /api/sessions へ model と permissionMode を渡し、claude を --model と --permission-mode で起動させる。
// 立った後の送信先の行のセレクト（SessionControls）はセッションの実際の値を読むので、まだチャットが無い段階でもこの値が出る。
// 送信先の行で選び直したら、そのセッションでは選んだ値が効く（configure_session）。
// 既定が効くのは、この画面から立てる新しい世帯だけ。引き継ぎ（resume と fork）は ccn が前任の値を継ぐので渡さない。
// 保存先は localStorage（新しい世帯の場所 claude-town.newHousePlace と同じ）。null は「設定しない」で、ccn に渡さず、ノードの Claude Code の既定で立つ。
import { MODELS, MODES } from "./control";

export const DEFAULTS_KEY = "claude-town.sessionDefaults";

export type SessionDefaults = { model: string | null; permissionMode: string | null };
export const NO_DEFAULTS: SessionDefaults = { model: null, permissionMode: null };

const pick = (v: unknown, ok: { value: string }[]) => (typeof v === "string" && ok.some((o) => o.value === v) ? v : null);

/** 候補（MODELS、MODES）に無い値は設定なしとして読む */
export function parseDefaults(raw: string | null): SessionDefaults {
  if (!raw) return NO_DEFAULTS;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return NO_DEFAULTS;
    return { model: pick(v.model, MODELS), permissionMode: pick(v.permissionMode, MODES) };
  } catch { return NO_DEFAULTS; }
}

export function loadDefaults(): SessionDefaults {
  try { return parseDefaults(localStorage.getItem(DEFAULTS_KEY)); } catch { return NO_DEFAULTS; }
}

/** 両方 null なら消す。保存できなくても動きは変えない */
export function saveDefaults(d: SessionDefaults) {
  try {
    if (!d.model && !d.permissionMode) localStorage.removeItem(DEFAULTS_KEY);
    else localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
  } catch { /* 保存できなくても動きは変えない */ }
}

export function sameDefaults(a: SessionDefaults, b: SessionDefaults): boolean {
  return a.model === b.model && a.permissionMode === b.permissionMode;
}
