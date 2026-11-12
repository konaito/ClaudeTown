// 開発版だけで使う、ターミナルを開くまでの自動の計測（#18）。
// 開発版の URL に ?bench=new|open|all&n=<回数> を付けると、起動して一覧が読めた3秒後から次を回す。
// - new: 「＋ 新しい世帯」のボタンを押し、入力欄（❯）が出るまでを測る。測り終えたら、作ったセッションだけを止める
// - open: 自分で作ったセッション1つを、選び直して右クリックと同じ操作で開き直し、❯ が見えるまでを測る
// - all: new を n 回、続けて最後に作ったセッションで open を n 回
// 結果は perf.ts が1回ごとに perf_log に書く。作るセッションには name に bench-ct-term を付ける。
import { useEffect, useRef } from "react";
import { call } from "../bridge";
import { perfNext } from "./perf";

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const mode = import.meta.env.DEV ? params.get("bench") : null;

/** 計測中に作るセッションの名前。計測していなければ null（名前を送らない） */
export const benchName = () => (mode ? "bench-ct-term" : null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useBench(h: { ready: boolean; select: (id: string | null) => void; focusId: (id: string) => void }) {
  const latest = useRef(h);
  latest.current = h;
  const started = useRef(false);
  useEffect(() => {
    if (!mode || !h.ready || started.current) return;
    started.current = true;
    run(() => latest.current).catch((e) => call("perf_log", { line: JSON.stringify({ bench: "error", message: String(e) }) }));
  }, [h.ready]);
}

async function run(h: () => { select: (id: string | null) => void; focusId: (id: string) => void }) {
  const n = Number(params.get("n") ?? 5);
  const mine: string[] = [];
  const log = (o: object) => call("perf_log", { line: JSON.stringify({ bench: mode, ...o }) });
  await sleep(3000);
  try {
    let last: string | null = null;
    if (mode === "new" || mode === "all" || mode === "open") {
      const rounds = mode === "open" ? 1 : n;
      for (let i = 0; i < rounds; i++) {
        const done = perfNext();
        const btn = document.querySelector<HTMLButtonElement>("button.new-house");
        if (!btn) throw new Error("新しい世帯のボタンが無い");
        btn.click();
        const r = await done;
        if (r.id) mine.push(r.id);
        last = r.id;
        await sleep(1500);
        // 最後の1つは open の計測に残す
        if (r.id && (mode === "new" || i < rounds - 1)) {
          h().select(null);
          await call("stop_session", { sessionId: r.id, peer: null }).catch(() => {});
          await sleep(2500);
        }
      }
    }
    if ((mode === "open" || mode === "all") && last) {
      await sleep(2000);
      for (let i = 0; i < n; i++) {
        h().select(null);
        await sleep(1200);
        const done = perfNext();
        h().focusId(last);
        await done;
        await sleep(800);
      }
      // ?type=1: 1字ずつ待たずに term_input を投げ、打った順に届くかを見る（#3）。届いた画面は ccn の replay で確かめる
      if (params.get("type")) {
        const text = "ordercheck-0123456789abcdefghijklmnopqrstuvwxyz";
        for (const ch of text) call("term_input", { sessionId: last, text: ch, peer: null });
        await sleep(1500);
        await log({ typed: text, id: last });
        await sleep(15000);
        await call("term_input", { sessionId: last, text: "\x15", peer: null });
      }
    }
  } finally {
    h().select(null);
    for (const id of mine) await call("stop_session", { sessionId: id, peer: null }).catch(() => {});
    await log({ done: true, stopped: mine });
  }
}
