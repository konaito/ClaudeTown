// セッションにできることの判断（#110）。画面と処理は Agent.capabilities を直接読まず、ここの関数を呼ぶ。
// 値は ccn の応答の capabilities（send、permissions、interrupt、stop、events、terminal）をそのまま読む。
// - capabilities が無い（null か undefined）ときは、全部「できない」。Claude Code の記録だけから読む native のセッション（#96）がこれにあたる
// - 値が true のときだけ「できる」。true 以外（false、undefined、想定外の型）は「できない」
// モデルと権限モードを替えられるかの判断は、別の前例として src/session/control.ts にある。

/** capabilities を持ちうるもの。Agent と、ccn の GET /sessions/<id> の応答（型が未確認のフィールドは unknown）の両方を受ける */
export type HasCaps = { capabilities?: { send?: unknown; permissions?: unknown; interrupt?: unknown; stop?: unknown; terminal?: unknown } | null } | null | undefined;

/** ccn から止められるか。閉じる、引き継ぎ（前任を止める）の前提 */
export const canStop = (a: HasCaps): boolean => a?.capabilities?.stop === true;

/** 作業中のターンを割り込んで止められるか */
export const canInterrupt = (a: HasCaps): boolean => a?.capabilities?.interrupt === true;

/** ccn から承認に答えられるか（人がターミナルで開いたセッションは答えられない） */
export const canAnswerPermission = (a: HasCaps): boolean => a?.capabilities?.permissions === true;

/** 端末（ターミナルのタブ）を持つか */
export const hasTerminal = (a: HasCaps): boolean => a?.capabilities?.terminal === true;

/** 何もできない capabilities。native のセッションの見た目確認用（?mock&native）が使う */
export const NO_CAPS = { send: false, permissions: false, interrupt: false, stop: false, terminal: false } as const;

/** ccn で新しく作った世帯（端末で動く）の、一覧に載るまでの仮の capabilities */
export const NEW_HOUSE_CAPS = { terminal: true, send: true, stop: true } as const;
