import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isVisible, onVisibleChange } from "../visible";
import { watchRestore, type RestoreReport } from "../restore";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 起動のときの端末の立て直しで戻らなかった端末を、トーストで1回知らせる（#262）。アプリ（Tauri）だけ。ブラウザ版には立て直しが無い */
export function useRestoreNotice(toast: (text: string, bad?: boolean) => void) {
  useEffect(() => {
    if (!inTauri) return;
    return watchRestore(() => invoke<RestoreReport>("restore_report"), (t) => toast(t, true), { isVisible, onVisibleChange });
  }, [toast]);
}
