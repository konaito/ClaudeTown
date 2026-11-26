// macOS のメニューバー（#300）の画面の側。メニューの木は Rust（src-tauri/src/menu.rs）が組む。
// - 自前の項目を押すと、Rust が id を "menu" の出来事で送る。ここで受けて、App が渡した既存の操作を呼ぶ
// - 押せる・押せないと文言の切り替えに要る状態を、変わるたびに menu_state で Rust に渡す
// ブラウザ版と、開発中にブラウザで開いたときはメニューが無いので、何もしない
import { useEffect, useRef } from "react";
import { IN_TAURI, call as invoke } from "./bridge";

/** 自前の項目の id。Rust の menu.rs の定数と同じ文字列（menu.test.ts で突き合わせる）。repo は Rust が自分で開くので、ここには来ない */
export const MENU_IDS = [
  "update", "settings", "new-house", "resume", "open-chat", "open-term", "sidebar",
  "zoom-in", "zoom-out", "zoom-fit", "tab-chat", "tab-state", "tab-term", "help-keys", "credits",
] as const;
export type MenuId = (typeof MENU_IDS)[number];

export const isMenuId = (v: unknown): v is MenuId => typeof v === "string" && (MENU_IDS as readonly string[]).includes(v);

/** Rust の MenuState と同じ形 */
export type MenuState = {
  /** セッションを選んでいる */
  selected: boolean;
  /** 選んでいるセッションにこのアプリの端末がある */
  terminal: boolean;
  /** 左のペイン（新しい世帯）が開いている */
  sidebar: boolean;
  /** 安定版の更新。null は更新の欄が無い版（開発版）か、まだ読めていない。true は更新がある */
  update: boolean | null;
};

export const sameMenuState = (a: MenuState, b: MenuState) =>
  a.selected === b.selected && a.terminal === b.terminal && a.sidebar === b.sidebar && a.update === b.update;

/**
 * メニューを押したときに actions の操作を呼び、state を Rust に渡す。
 * actions は毎回の描画の値を使う（古い選択のまま操作しない）。state は変わったときと、画面を読み直したとき（mount）に渡す
 */
export function useMenu(actions: Record<MenuId, () => void>, state: MenuState) {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    if (!IN_TAURI) return;
    let off: (() => void) | null = null;
    let live = true;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string>("menu", (e) => {
      if (isMenuId(e.payload)) latest.current[e.payload]();
    })).then((u) => { if (live) off = u; else u(); });
    return () => { live = false; off?.(); };
  }, []);
  const sent = useRef<MenuState | null>(null);
  useEffect(() => {
    if (!IN_TAURI || (sent.current && sameMenuState(sent.current, state))) return;
    sent.current = state;
    invoke("menu_state", { state }).catch(() => { sent.current = null; });
  }, [state.selected, state.terminal, state.sidebar, state.update]);
}
