import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 長時間の記録（#15）でだけ入る。VITE_FC_SOAK を付けずにビルドすれば、この import は消える
if (import.meta.env.VITE_FC_SOAK) import("./soak");

// 自動の計測（?bench、src/term/bench.ts）では StrictMode を外す。開発版だけ effect が2回走り、ターミナルを2回開いて数字がずれるため
const bench = new URLSearchParams(location.search).has("bench");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  bench ? <App /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
