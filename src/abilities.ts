// セッションにできることの判断（#110）。画面と処理は Agent.capabilities を直接読まず、ここの関数を呼ぶ。
// 値は Rust の snapshot（アプリが立てた端末は app_caps、記録から読むだけのセッションは read_only_caps）か、ブラウザ版では ccn の応答の capabilities をそのまま読む。
// - capabilities が無い（null か undefined）ときは、全部「できない」
// - 値が true のときだけ「できる」。true 以外（false、undefined、想定外の型）は「できない」
// モデルと権限モードを替えられるかの判断は、別の前例として src/session/control.ts にある。

/** capabilities を持ちうるもの。Agent と、ブラウザ版の ccn の GET /sessions/<id> の応答（型が未確認のフィールドは unknown）の両方を受ける */
export type HasCaps = { capabilities?: { send?: unknown; permissions?: unknown; interrupt?: unknown; stop?: unknown; terminal?: unknown } | null } | null | undefined;

/** ここから止められるか（閉じるの前提）。アプリが立てたセッションだけ */
export const canStop = (a: HasCaps): boolean => a?.capabilities?.stop === true;

/** 作業中のターンを割り込んで止められるか */
export const canInterrupt = (a: HasCaps): boolean => a?.capabilities?.interrupt === true;

/** 承認の欄から答えられるか。ブラウザ版の ccn の行だけ。アプリが立てたセッションは端末の承認の画面で答える */
export const canAnswerPermission = (a: HasCaps): boolean => a?.capabilities?.permissions === true;

/** 端末（ターミナルのタブ）を持つか */
export const hasTerminal = (a: HasCaps): boolean => a?.capabilities?.terminal === true;

/** 何もできない capabilities。記録から読むだけのセッションと同じ値 */
export const NO_CAPS = { send: false, permissions: false, interrupt: false, stop: false, terminal: false } as const;

/** 新しく作った世帯（アプリの中の端末で動く）の、一覧に載るまでの仮の capabilities */
export const NEW_HOUSE_CAPS = { terminal: true, send: true, stop: true, interrupt: true } as const;
