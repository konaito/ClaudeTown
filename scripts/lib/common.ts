// scripts/ の計測と模擬のスクリプトで共有する補助関数（#114）。
// 計測の定義が変わる関数（sh、rssMB、arg）は、各スクリプトに残してある。
import { spawnSync } from "node:child_process";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** WebKit のプロセス（WebContent、GPU、Networking）の pid */
export const webkitPids = (): number[] =>
  (spawnSync("/usr/bin/pgrep", ["-f", "com.apple.WebKit.(WebContent|GPU|Networking)"], { encoding: "utf8" }).stdout ?? "")
    .trim().split("\n").filter(Boolean).map(Number);

/** JSON の Response。headers には CORS など、スクリプトごとの追加のヘッダーを渡す */
export const jsonResponse = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
