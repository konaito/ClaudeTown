// 画面のアイコンは lucide-react（ISC）にそろえる。大きさと線の太さはここで決め、各所はこの値を渡す（lucide の既定は 24 と 2）。
// 基準はヘッダー（18）。小さい場所は 16 か 14。カードの縁の操作ボタン（19px の箱）と 11px の文字の行だけは 12 にする。
// Noto Animated Emoji の素材（状態の印、閉じる演出の幽霊、お手紙の封筒）とキャラの絵は、アイコンではなく演出の素材なので、ここに入れない。
import { Baby, Crown, User, type LucideIcon } from "lucide-react";

export const STROKE = 1.8;
/** lg: ヘッダー、送るボタン、お便りの先頭。md: 閉じる、ズーム、承認の見出し、新しい世帯。sm: 札、見出しの行、チップ、イベント。xs: カードの縁のボタン、道具の行、コピー */
export const ICON = { lg: 18, md: 16, sm: 14, xs: 12 } as const;

/**
 * カードの左上の札（親、子、孫…）のアイコン。深さで引き、ROLE_LABEL と同じ並びにする。
 * 親は世帯の長なので王冠、子は人、孫より下は赤ちゃん。lucide に人の年齢の段を表すアイコンが3つしかないので、孫、ひ孫、玄孫は同じ絵にし、
 * 見分けは札の title と aria-label（ROLE_LABEL の文字）で行う
 */
export const ROLE_ICON: LucideIcon[] = [Crown, User, Baby, Baby, Baby];
