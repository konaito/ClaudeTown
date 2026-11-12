// 右パネルの端末。ccn の PTY の出力を xterm.js に流し、打ったキーを PTY に書く。
// 開いている間だけ繋ぎ、閉じたら切る（30本を同時に描かない）。開いたときに自分の大きさを ccn に伝える（後勝ち）。
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { call, openTerminal } from "../bridge";
import { perfCounters, perfMark, perfEnd, perfTerm, perfWaitingPrompt } from "./perf";

const SIZE_KEY = "claude-town.term-size";
/** ほかの画面の大きさが右パネルに収まらないとき、こちらの大きさを送り返す間隔の下限 */
const FOREIGN_RECLAIM_MS = 5000;
/** 最後に開いたターミナルの大きさ。新しい世帯をこの大きさで起動する */
export function lastTermSize(): { cols: number; rows: number } | null {
  try { const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null"); return v?.cols && v?.rows ? v : null; } catch { return null; }
}

export function TerminalView({ sessionId, peer, onError, takeEarly }: { sessionId: string; peer: string | null; onError: (m: string) => void; takeEarly?: (id: string) => string }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>("起動中…");

  useEffect(() => {
    if (!box.current) return;
    perfMark("mount", sessionId);
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, "Hiragino Sans", monospace', fontSize: 12.5, lineHeight: 1.15,
      cursorBlink: true,
      // claude は入力欄から上を描き直し続けるので、遡る行はそれほど要らない。5000 から減らしてメモリと再描画の量を抑える（#8）
      scrollback: 1000, allowProposedApi: false,
      theme: { background: "#ffffff", foreground: "#2f2d36", cursor: "#2f2d36", selectionBackground: "#cfe0ff", black: "#2f2d36", brightBlack: "#8a8794" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    if (import.meta.env.DEV) perfTerm.current = term;
    // GPU で描く（#8）。何も指定しないと xterm.js は DOM で描き、claude の書き換えのたびに WebContent の負荷になる。
    // WebGL が使えないときと、文脈を失ったときは、アドオンを外して DOM の描き方に戻す
    let gl: WebglAddon | null = null;
    // 開発の計測用: ?renderer=dom で DOM の描き方のまま比べる
    if (import.meta.env.DEV && new URLSearchParams(location.search).get("renderer") === "dom") perfCounters.renderer = "dom";
    else try {
      gl = new WebglAddon();
      gl.onContextLoss(() => { gl?.dispose(); gl = null; perfCounters.renderer = "dom（文脈を失った）"; });
      term.loadAddon(gl);
      perfCounters.renderer = "webgl";
    } catch { gl = null; perfCounters.renderer = "dom"; }
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
    // PTY に最後に送った大きさ。届いた size がこれと違えば、ほかの画面（ccn.fybe.jp など）が大きさを変えた
    let sentSize = "";
    // ほかの画面の大きさに合わせている間は、replay のたびに自分の大きさを送り返さない（相手も送り返すと取り合いが続く）。
    // 本人がここで打つか、右パネルの大きさが変わったら、こちらの大きさに戻す（後から操作した画面の大きさになる。#19）。
    // ただし相手の大きさが右パネルに収まらないとき（右や下が切れて見えない）は、合わせずにこちらの大きさを送り返す。
    // 相手も送り返す作りでも取り合いが速く回らないよう、送り返しは FOREIGN_RECLAIM_MS に1回までにする
    let following = false;
    let reclaimedAt = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const pushSize = () => {
      try { fit.fit(); } catch { return; }
      const key = `${term.cols}x${term.rows}`;
      if (key === lastSize) return;
      lastSize = key;
      try { localStorage.setItem(SIZE_KEY, JSON.stringify({ cols: term.cols, rows: term.rows })); } catch { /* 残せなくても動きは変えない */ }
      // 境目のドラッグ中は大きさが続けて変わるので、PTY への通知は止まってから 150ms 後に1回だけ送る（画面の fit はすぐ）
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        perfCounters.resizes++;
        perfCounters.lastResizeAt = performance.now();
        sentSize = `${term.cols}x${term.rows}`;
        call("term_resize", { sessionId, cols: term.cols, rows: term.rows, peer }).catch((e) => onError(`ターミナルの大きさを変えられなかった: ${e}`));
      }, 150);
    };
    // 本人がここで打ったら（キー、貼り付け、IME の確定）、こちらの大きさに戻す。onData では見ない。
    // claude はフォーカスの報告（ESC[?1004h）を有効にするので、窓から離れただけでも onData に ESC[O が流れる
    const reclaim = () => { if (following) { following = false; lastSize = ""; pushSize(); } };
    const ta = term.textarea;
    for (const ev of ["keydown", "paste", "compositionend"]) ta?.addEventListener(ev, reclaim);
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
          let reclaimNow = false;
          if (sentSize && e.data?.cols && `${e.data.cols}x${e.data.rows}` !== sentSize) {
            const fits = fit.proposeDimensions();
            const tooBig = !!fits && (e.data.cols > fits.cols || e.data.rows > fits.rows);
            if (tooBig && Date.now() - reclaimedAt > FOREIGN_RECLAIM_MS) { following = false; reclaimedAt = Date.now(); reclaimNow = true; }
            else following = true;
          }
          if (e.data?.cols && e.data?.rows && (e.data.cols !== term.cols || e.data.rows !== term.rows)) {
            try { term.resize(e.data.cols, e.data.rows); } catch { /* 大きさを変えられなくても書くのは続ける */ }
          }
          // 大きさが変わった後に replay が来るとは限らないので、送り返しはここで始める
          if (reclaimNow) { lastSize = ""; pushSize(); }
          break;
        case "replay":
          if (pendingReset) { term.reset(); pendingReset = false; }
          replaying++;
          // 書き終えたら、右パネルの大きさに合わせ直して PTY にも伝える。ほかの画面の大きさに合わせている間は送り返さない
          term.write(e.data?.s ?? "", () => { replaying--; if (!following) { lastSize = ""; pushSize(); } afterWrite(); });
          if (e.data?.s) onFirstOutput();
          break;
        case "data":
          pendingReset = false;
          term.write(e.data?.s ?? "", afterWrite);
          onFirstOutput();
          break;
        case "exit":
          setStatus(`終わった（${e.data?.reason ?? ""}${e.data?.code != null ? `、終了コード ${e.data.code}` : ""}）`);
          break;
        case "input_error":
          onError(e.data?.message ?? "ターミナルに書けなかった");
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
    let boxSize = "";
    const ro = new ResizeObserver((es) => {
      const r = es[es.length - 1]?.contentRect;
      const k = r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "";
      if (following && k === boxSize) return;
      boxSize = k;
      if (following) { following = false; lastSize = ""; }
      pushSize();
    });
    ro.observe(box.current);
    return () => {
      closed = true;
      ro.disconnect();
      for (const ev of ["keydown", "paste", "compositionend"]) ta?.removeEventListener(ev, reclaim);
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
