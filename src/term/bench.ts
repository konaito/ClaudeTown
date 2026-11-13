// 開発版だけで使う、ターミナルを開くまでの自動の計測（#18）。
// 開発版の URL に ?bench=new|open|all&n=<回数> を付けると、起動して一覧が読めた3秒後から次を回す。
// - new: 「＋ 新しい世帯」のボタンを押し、右パネルのチャットの入力欄にフォーカスが入るまでを測る（端末は開かない）。測り終えたら、作ったセッションだけを止める
// - open: 自分で作ったセッション1つを、選び直して右クリックと同じ操作で開き直し、❯ が見えるまでを測る
// - all: new を n 回、続けて最後に作ったセッションで open を n 回
// - watch: 40秒、1秒ごとに町の人数と接続の表示を記録する
// - resize: 新しい世帯の右パネルの境目をドラッグし、claude が新しい幅で描き直すまでを測る（#19）
// - cpu: ?sid=<セッション> のターミナルを開いたまま30秒、IPC の回数を数える（#8、#9。scripts/mock-ccn-flood.ts と使う）
// - scene: 軽さの計測（scripts/bench.ts、#2）。場面（scene=idle|hidden|minimized|terminal|talk|town）を用意して ready を書き、
//   wait（ms）たったら post を書く。CPU とメモリは bench.ts が外から ps で測る。測っている間は、ここでは何も回さない
// 結果は perf.ts が1回ごとに perf_log に書く。作るセッションには name に bench-ct-term を付ける。
// 引数は URL（?bench=…）か、環境変数 VITE_FC_BENCH（"bench=scene&scene=idle" の形）で渡す。
// 環境変数なら devUrl を変えずに済むので、場面ごとに Rust を組み直さない（devUrl は Rust に埋め込まれる）
import { useEffect, useRef } from "react";
import { call } from "../bridge";
import { perfCounters, perfNext, perfTerm } from "./perf";

const fromEnv = import.meta.env.DEV ? (import.meta.env.VITE_FC_BENCH as string | undefined) : undefined;
/** 計測の引数。開発版だけで読む */
export const benchParams = new URLSearchParams(fromEnv ?? (typeof location !== "undefined" ? location.search : ""));
const params = benchParams;
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
    // 一覧を読んで町を描いた最初の描画の時刻（起動の時間に使う。Rust が書く procStartMs との差）
    if (mode === "scene") requestAnimationFrame(() => { paintedAt = Date.now(); });
    run(() => latest.current).catch((e) => call("perf_log", { line: JSON.stringify({ bench: "error", message: String(e) }) }));
  }, [h.ready]);
}

let paintedAt = 0;

/** ms のあいだ requestAnimationFrame が何回呼ばれたか（1秒あたり）。窓が隠れていれば 0 になる */
async function fps(ms: number) {
  let frames = 0, on = true;
  const raf = () => { if (!on) return; frames++; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  await sleep(ms);
  on = false;
  return +((frames * 1000) / ms).toFixed(1);
}

async function run(h: () => { select: (id: string | null) => void; focusId: (id: string) => void }) {
  const n = Number(params.get("n") ?? 5);
  const mine: string[] = [];
  const log = (o: object) => call("perf_log", { line: JSON.stringify({ bench: mode, ...o }) });
  await sleep(3000);
  try {
    if (mode === "scene") {
      const scene = params.get("scene") ?? "idle";
      const sid = params.get("sid") ?? "";
      // 見え方が途中で変わったら記録する（見えている前提の場面で隠れた回を、bench.ts が無効にする）
      const vis: { at: number; state: string }[] = [];
      // その場でも1行書く。scripts/bench.ts はこれを見て、見えるはずの場面で隠れた回をすぐ打ち切る
      const onVis = () => { vis.push({ at: Date.now(), state: document.visibilityState }); log({ visChange: document.visibilityState, at: Date.now() }); };
      document.addEventListener("visibilitychange", onVis);
      if (scene === "terminal") {
        // 開いたときの計測（perf.ts の open の流れ）が終わるまで待つ。終わるまでは perf_ping を20ms ごとに回している
        const opened = perfNext();
        h().focusId(sid);
        await Promise.race([opened, sleep(25000)]);
      } else if (scene === "talk") {
        h().select(sid);
      } else if (scene === "hidden" || scene === "minimized") {
        await call("perf_window", { op: scene === "hidden" ? "hide" : "minimize" });
      }
      await sleep(3000);
      const ipc0 = { ...perfCounters };
      await log({ ready: true, scene, at: Date.now(), paintedAt, vis: document.visibilityState, focus: document.hasFocus(), fps: await fps(1000), renderer: perfCounters.renderer || null });
      const wait = Number(params.get("wait") ?? 65000);
      const t0 = Date.now();
      await sleep(wait);
      const secs = (Date.now() - t0) / 1000;
      await log({ post: true, scene, at: Date.now(), vis: document.visibilityState, visEvents: vis, fps: await fps(1000),
        ipcPerSec: +((perfCounters.ipc - ipc0.ipc) / secs).toFixed(1), charsPerSec: Math.round((perfCounters.bytes - ipc0.bytes) / secs) });
      document.removeEventListener("visibilitychange", onVis);
      return;
    }
    // cpu: ?sid=<セッション> のターミナルを開いたまま、5秒置いてから30秒、IPC の回数を数える。CPU 時間は外から ps で測る。
    // 窓が裏にあると WebKit が描画を止めるので、FC_BENCH_TOP=1 で起動して最前面に出す（lib.rs の setup）
    // resize: 新しい世帯を1つ作り、右パネルの境目をドラッグして広げてから狭め、claude が新しい幅で描き直すまでを測る（#19）
    if (mode === "resize") {
      const done = perfNext();
      document.querySelector<HTMLButtonElement>("button.new-house")?.click();
      const r = await done;
      if (!r.id) throw new Error("作れなかった");
      mine.push(r.id);
      await sleep(3000);
      for (const dx of [-250, 250, -120]) {
        await log({ resize: dx, ...(await dragAndWatch(dx)) });
        await sleep(2000);
      }
      // 開き直したときの replay が新しい幅になっているか
      h().select(null);
      await sleep(1000);
      const re = perfNext();
      h().focusId(r.id);
      await re;
      await sleep(800);
      await log({ reopen: true, cols: perfTerm.current?.cols, rules: rules() });
      // ほかの画面が大きさを変えた（ここでは自分の書き手で送って真似る）。こちらは合わせるだけで、送り返さない。
      // 狭い相手（50×20）と、右パネルより広い相手（200×50）の2通り
      const t = perfTerm.current!;
      const mine0 = `${t.cols}x${t.rows}`;
      for (const [cols, rows] of [[50, 20], [200, 50]]) {
        const r0 = perfCounters.resizes;
        await call("term_resize", { sessionId: r.id, cols, rows, peer: null });
        await sleep(3000);
        // 窓から離れて戻る（claude はフォーカスの報告を有効にしているので、ESC[O と ESC[I が onData に流れる）
        t.blur();
        await sleep(300);
        t.focus();
        await sleep(1500);
        const box = document.querySelector(".term")?.getBoundingClientRect();
        const screen = document.querySelector(".term .xterm-screen")?.getBoundingClientRect();
        await log({ foreign: `${cols}x${rows}`, xterm: `${t.cols}x${t.rows}`, sentBackAfterBlur: perfCounters.resizes - r0, rules: rules(),
          // 相手が広いと、xterm の画面が欄からはみ出す（はみ出した分は見えない）
          overflowPx: box && screen ? Math.round(screen.width - box.width) : null });
        // 本人がここで打つと、こちらの大きさに戻す
        t.textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        t.input(" ");
        await sleep(3000);
        await log({ typed: true, xterm: `${t.cols}x${t.rows}`, mine: mine0, sent: perfCounters.resizes - r0, rules: rules() });
        t.input("\x7f");
        await sleep(1000);
      }
      return;
    }
    // watch: 40秒、1秒ごとに町の人数と接続の表示を記録する（一覧の取得が失敗しても町が消えないかを見る）
    if (mode === "watch") {
      for (let i = 0; i < 40; i++) {
        await log({ t: i, at: new Date().toISOString().slice(11, 23), town: document.querySelector(".fam-title")?.textContent ?? "", conn: document.querySelector(".conn")?.textContent ?? "", banner: !!document.querySelector(".banner.bad") });
        await sleep(1000);
      }
      return;
    }
    if (mode === "cpu") {
      const sid = params.get("sid") ?? "";
      h().focusId(sid);
      await sleep(5000);
      const a = { ...perfCounters };
      // 描画の回数も数える。窓が隠れていると WebKit が描画を止め、描画の負荷が CPU に出ないので、その回は使わない
      let frames = 0, on = true;
      const raf = () => { if (!on) return; frames++; requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
      await log({ cpu_start: true });
      await sleep(30000);
      on = false;
      await log({ cpu_end: true, ipcPerSec: +((perfCounters.ipc - a.ipc) / 30).toFixed(1), charsPerSec: Math.round((perfCounters.bytes - a.bytes) / 30), fps: +(frames / 30).toFixed(1), renderer: perfCounters.renderer || "dom" });
      return;
    }
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

/** 画面に見えている行のうち、横線（─ が10個以上続く行）の長さと、前の行の折り返しの続きになっている横線の数 */
function rules(): { widths: number[]; wrapped: number } {
  const t = perfTerm.current;
  if (!t) return { widths: [], wrapped: 0 };
  const b = t.buffer.active;
  const widths: number[] = [];
  let wrapped = 0;
  for (let y = 0; y < t.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    const text = line?.translateToString(true) ?? "";
    const m = text.match(/─{10,}/);
    if (!m) continue;
    if (line?.isWrapped) wrapped++;
    widths.push(m[0].length);
  }
  return { widths, wrapped };
}

/** 右パネルの境目を dx（px）だけ、0.5秒かけてドラッグする。離してから、一番長い横線が新しい幅になるまでの時間を測る */
async function dragAndWatch(dx: number) {
  const t = perfTerm.current;
  const sep = document.querySelector<HTMLElement>(".split-handle");
  if (!t || !sep) return { error: "ターミナルか境目が無い" };
  const before = { cols: t.cols, rules: rules() };
  const r0 = perfCounters.resizes;
  const box = sep.getBoundingClientRect();
  const x0 = box.left + box.width / 2, y = box.top + box.height / 2;
  const ev = (type: string, x: number) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1 });
  // 一番長い横線（入力欄の上下の線）が今の幅になり、折り返しの続きの横線が無い（見出し付きの枠の線は短いので見ない）
  const clean = () => { const now = rules(); return now.wrapped === 0 && Math.max(0, ...now.widths) === t.cols; };
  // 大きさを送るたびに、送ってから画面が今の幅で揃うまでを測る。窓が隠れていると setTimeout が間引かれるので、
  // xterm が出力を解き終えたとき（onWriteParsed）に判定する
  const lat: number[] = [];
  let sentSeen = perfCounters.lastResizeAt;
  let waiting = false;
  const d = t.onWriteParsed(() => {
    if (perfCounters.lastResizeAt !== sentSeen) { sentSeen = perfCounters.lastResizeAt; waiting = true; }
    if (waiting && clean()) { lat.push(Math.round(performance.now() - sentSeen)); waiting = false; }
  });
  sep.dispatchEvent(ev("pointerdown", x0));
  for (let i = 1; i <= 10; i++) {
    document.dispatchEvent(ev("pointermove", x0 + (dx * i) / 10));
    await sleep(50);
  }
  document.dispatchEvent(ev("pointerup", x0 + dx));
  await sleep(4000);
  d.dispose();
  return {
    colsBefore: before.cols, colsAfter: t.cols, rulesBefore: before.rules, rulesAfter: rules(), cleanAtEnd: clean(),
    resizeCalls: perfCounters.resizes - r0,
    // 大きさを送ってから、claude の描き直しが届いて画面が揃うまで（ms）。送った回ごと
    redrawAfterSend: lat,
  };
}
