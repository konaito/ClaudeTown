// スマホ専用の画面に切り替える判定と、画面の高さの追従。
import { useEffect, useState } from "react";

/**
 * 幅が狭い（720px 以下）か、タッチが主の入力で幅が 1024px 以下のときだけ、スマホ専用の画面にする。
 * タッチ付きの PC やタブレットの横向きは、広ければ今までの画面のまま。
 * Tauri の画面（デスクトップアプリ）は常に偽。URL に ?layout=mobile か ?layout=desktop を付けると、判定を上書きする（確認用）。
 */
const QUERY = "(max-width: 720px), (pointer: coarse) and (max-width: 1024px)";

export const inTauriWindow = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function forced(): "mobile" | "desktop" | null {
  const v = typeof location !== "undefined" ? new URLSearchParams(location.search).get("layout") : null;
  return v === "mobile" || v === "desktop" ? v : null;
}

export function isMobileNow(): boolean {
  if (inTauriWindow() || typeof window === "undefined") return false;
  const f = forced();
  if (f) return f === "mobile";
  return window.matchMedia(QUERY).matches;
}

export function useMobileLayout(): boolean {
  const [m, setM] = useState(isMobileNow);
  useEffect(() => {
    if (inTauriWindow() || forced()) return;
    const mq = window.matchMedia(QUERY);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

/**
 * 画面の見えている高さを --vv-h、上端のずれを --vv-top に入れる。キーボードが出ても入力欄が隠れないようにする。
 * dvh はキーボードで縮まず（iOS Safari も Chrome の既定も）、visualViewport だけが縮むため。
 * キーボードが出ている間は、下の安全領域（ホームバー）の余白を外すため、html に kb の印を付ける
 */
export function useVisualViewport(on: boolean) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!on || !vv) return;
    const root = document.documentElement;
    const set = () => {
      root.style.setProperty("--vv-h", `${vv.height}px`);
      root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
      root.classList.toggle("kb", window.innerHeight - vv.height > 120);
    };
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      root.style.removeProperty("--vv-h");
      root.style.removeProperty("--vv-top");
      root.classList.remove("kb");
    };
  }, [on]);
}
