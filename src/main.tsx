import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 自動の計測（?bench、src/term/bench.ts）では StrictMode を外す。開発版だけ effect が2回走り、ターミナルを2回開いて数字がずれるため
const bench = new URLSearchParams(location.search).has("bench");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  bench ? <App /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
