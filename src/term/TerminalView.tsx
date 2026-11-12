// 右パネルの端末。ccn の PTY の出力を xterm.js に流し、打ったキーを PTY に書く。
// 開いている間だけ繋ぎ、閉じたら切る（30本を同時に描かない）。開いたときに自分の大きさを ccn に伝える（後勝ち）。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, openTerminal } from "../bridge";

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function TerminalView({ sessionId, peer, onError }: { sessionId: string; peer: string | null; onError: (m: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>("繋いでいる…");

  useEffect(() => {
    if (!box.current) return;
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
    let lastSize = "";
    const pushSize = () => {
      try { fit.fit(); } catch { return; }
      const key = `${term.cols}x${term.rows}`;
      if (key === lastSize) return;
      lastSize = key;
      call("term_resize", { sessionId, cols: term.cols, rows: term.rows, peer }).catch((e) => onError(`端末の大きさを変えられなかった: ${e}`));
    };
    const disposeInput = term.onData((text) => {
      if (replaying > 0) return;
      call("term_input", { sessionId, text, peer }).catch((e) => onError(`端末に書けなかった: ${e}`));
    });
    let close = () => {};
    openTerminal(sessionId, peer, (e) => {
      if (closed) return;
      switch (e.ev) {
        case "size":
          // 繋いだ直後か、ほかの画面が大きさを変えた。続けて replay が来たら、その前に画面を消す
          pendingReset = true;
          setStatus("");
          break;
        case "replay":
          if (pendingReset) { term.reset(); pendingReset = false; }
          replaying++;
          term.write(b64ToBytes(e.data?.b64 ?? ""), () => { replaying--; });
          break;
        case "data":
          pendingReset = false;
          term.write(b64ToBytes(e.data?.b64 ?? ""));
          break;
        case "exit":
          setStatus(`終わった（${e.data?.reason ?? ""}${e.data?.code != null ? `、終了コード ${e.data.code}` : ""}）`);
          break;
        case "error":
          setStatus(e.data?.message ?? "端末に繋がらない");
          break;
      }
    }).then((c) => {
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
