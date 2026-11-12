// 右パネルの端末。ccn の PTY の出力を xterm.js に流し、打ったキーを PTY に書く。
// 開いている間だけ繋ぎ、閉じたら切る（30本を同時に描かない）。開いたときに自分の大きさを ccn に伝える（後勝ち）。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, openTerminal } from "../bridge";
import { perfMark, perfEnd, perfWaitingPrompt } from "./perf";

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function TerminalView({ sessionId, peer, onError, takeEarly }: { sessionId: string; peer: string | null; onError: (m: string) => void; takeEarly?: (id: string) => string }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>("起動中…");

  useEffect(() => {
    if (!box.current) return;
    perfMark("mount", sessionId);
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, "Hiragino Sans", monospace', fontSize: 12.5, lineHeight: 1.15,
      cursorBlink: true, scrollback: 5000, allowProposedApi: false,
      theme: { background: "#ffffff", foreground: "#2f2d36", cursor: "#2f2d36", selectionBackground: "#cfe0ff", black: "#2f2d36", brightBlack: "#8a8794" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    let pendingReset = false;
    // replay を書いている間に xterm.js が返す自動応答（カーソル位置の報告など）は PTY に送らない（claude の入力に混ざるため）
    let replaying = 0;
    let closed = false;
    // 最初の出力が来たら、フォーカスを当て直し、起動前に打たれたキーを流す
    let gotOutput = false;
    // 計測（#18）: 書き終えたら、最初の描画と入力欄（❯）が見えたかを印にする
    const afterWrite = () => {
      if (!gotOutput) return;
      perfMark("drawn", sessionId);
      if (!perfWaitingPrompt(sessionId)) return;
      const b = term.buffer.active;
      for (let y = 0; y < term.rows; y++) {
        if (b.getLine(b.viewportY + y)?.translateToString(true).includes("❯")) { perfMark("prompt", sessionId); perfEnd(); return; }
      }
    };
    const onFirstOutput = () => {
      if (gotOutput) return;
      perfMark("first_output", sessionId);
      gotOutput = true;
      setStatus("");
      term.focus();
      const t = takeEarly?.(sessionId) ?? "";
      if (t) setTimeout(() => call("term_input", { sessionId, text: t, peer }).catch((e) => onError(`ターミナルに書けなかった: ${e}`)), 300);
    };
    let lastSize = "";
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const pushSize = () => {
      try { fit.fit(); } catch { return; }
      const key = `${term.cols}x${term.rows}`;
      if (key === lastSize) return;
      lastSize = key;
      // 境目のドラッグ中は大きさが続けて変わるので、PTY への通知は止まってから 150ms 後に1回だけ送る（画面の fit はすぐ）
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        call("term_resize", { sessionId, cols: term.cols, rows: term.rows, peer }).catch((e) => onError(`ターミナルの大きさを変えられなかった: ${e}`));
      }, 150);
    };
    const disposeInput = term.onData((text) => {
      if (replaying > 0) return;
      call("term_input", { sessionId, text, peer }).catch((e) => onError(`ターミナルに書けなかった: ${e}`));
    });
    let close = () => {};
    openTerminal(sessionId, peer, (e) => {
      if (closed) return;
      switch (e.ev) {
        case "size":
          perfMark("size", sessionId);
          // 繋いだ直後か、ほかの画面が大きさを変えた。続けて replay が来たら、その前に画面を消す。
          // replay はノードの cols と rows で作った画面のスナップショットなので、まず xterm をその大きさにする（ccn PR #19）
          pendingReset = true;
          if (e.data?.cols && e.data?.rows && (e.data.cols !== term.cols || e.data.rows !== term.rows)) {
            try { term.resize(e.data.cols, e.data.rows); } catch { /* 大きさを変えられなくても書くのは続ける */ }
          }
          break;
        case "replay":
          if (pendingReset) { term.reset(); pendingReset = false; }
          replaying++;
          // 書き終えたら、右パネルの大きさに合わせ直して PTY にも伝える
          term.write(b64ToBytes(e.data?.b64 ?? ""), () => { replaying--; lastSize = ""; pushSize(); afterWrite(); });
          if (e.data?.b64) onFirstOutput();
          break;
        case "data":
          pendingReset = false;
          term.write(b64ToBytes(e.data?.b64 ?? ""), afterWrite);
          onFirstOutput();
          break;
        case "exit":
          setStatus(`終わった（${e.data?.reason ?? ""}${e.data?.code != null ? `、終了コード ${e.data.code}` : ""}）`);
          break;
        case "error":
          setStatus(e.data?.message ?? "ターミナルに繋がらない");
          // 端末が開かないなら、起動待ちでためた文字を捨てて横取りをやめる
          takeEarly?.(sessionId);
          break;
      }
    }).then((c) => {
      perfMark("term_open", sessionId);
      if (closed) c(); else { close = c; pushSize(); term.focus(); }
    });
    const ro = new ResizeObserver(() => pushSize());
    ro.observe(box.current);
    return () => {
      closed = true;
      ro.disconnect();
      disposeInput.dispose();
      close();
      term.dispose();
    };
  }, [sessionId, peer]);

  return (
    <div className="term-wrap">
      {status && <div className="term-status">{status}</div>}
      <div className="term" ref={box} />
    </div>
  );
}
