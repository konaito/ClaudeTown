import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 長時間の記録（#15）でだけ入る。VITE_FC_SOAK を付けずにビルドすれば、この import は消える
if (import.meta.env.VITE_FC_SOAK) import("./soak");

// PWA。ビルドした版を Tauri の外で開いたときだけ Service Worker を登録する（public/sw.js は何もキャッシュしない）。
// 開発サーバー（localhost:1420 は全 worktree の共有オリジン）では登録しない
if (import.meta.env.PROD && !("__TAURI_INTERNALS__" in window) && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {}));
}

// 自動の計測（?bench、src/term/bench.ts）では StrictMode を外す。開発版だけ effect が2回走り、ターミナルを2回開いて数字がずれるため
const bench = new URLSearchParams(location.search).has("bench");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  bench ? <App /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
