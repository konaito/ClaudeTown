// Tauri の命令を呼ぶ口。ブラウザで開いたとき（開発中の見た目の確認）は public/dev-*.json を読み、送信と移動はしない。
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function devJson<T>(name: string, fallback: T): Promise<T> {
  const r = await fetch(`/${name}`, { cache: "no-store" });
  if (!r.ok) return fallback;
  return (await r.json()) as T;
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) return invoke<T>(cmd, args);
  if (cmd === "snapshot") {
    const r = await fetch("/dev-snapshot.json", { cache: "no-store" });
    if (!r.ok) throw new Error("dev-snapshot.json が無い。`src-tauri/target/debug/family-computing --snapshot > public/dev-snapshot.json` で作る");
    return (await r.json()) as T;
  }
  if (cmd === "peers") return devJson<T>("dev-peers.json", [] as T);
  if (cmd === "conversation") return devJson<T>("dev-conversation.json", [] as T);
  console.info("[ブラウザ表示なので実行しない]", cmd, args);
  return "ブラウザ表示" as T;
}

export async function setFullscreen() {
  if (inTauri) {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}
