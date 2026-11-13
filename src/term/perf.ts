// ターミナルを開くまでの区間の計測（#18）。
// 「新しい世帯」を押したとき（new）と、右クリックで既存のセッションのターミナルを開いたとき（open）に、
// 押した時刻からの経過（ms）を区間ごとに残し、終わったら1行の JSON にして Rust の perf_log に渡す。
// new はチャットの入力欄にフォーカスが入ったところ（composer）で、open は端末の入力欄（❯）が見えたところで終わる。
// 流れの間は、何もしない命令（perf_ping）の往復時間と、描画の間隔（requestAnimationFrame）も測る。
// perf_ping は同期の命令なので、往復が長ければ Rust のメインスレッドが止まっている（#3 の証拠）。
import { call } from "../bridge";

export type FlowKind = "new" | "open";
type Flow = {
  kind: FlowKind; t0: number; id: string | null; marks: Record<string, number>;
  pings: number[]; rafMax: number; done: boolean; resolve: (r: PerfResult) => void;
};
export type PerfResult = { kind: FlowKind; id: string | null; marks: Record<string, number>; ping: { n: number; p50: number; max: number }; rafMax: number };

/** 計測は開発版だけで動かす。製品版では印も probe も何もしない（右クリックのたびに perf_ping を回さない） */
const ACTIVE = import.meta.env.DEV;
let cur: Flow | null = null;
/** ターミナルの出力が画面に届いた回数（Rust から webview への IPC の回数）。bench.ts の cpu が1秒あたりに直す */
export const perfCounters = { ipc: 0, bytes: 0, renderer: "", resizes: 0, lastResizeAt: 0 };
/** 開いているターミナル（自動の計測 bench.ts が画面の中身を読む）。開発版だけで入れる */
export const perfTerm: { current: import("@xterm/xterm").Terminal | null } = { current: null };
let waiters: ((r: PerfResult) => void)[] = [];
/** 次に終わる流れの結果を待つ（自動の計測 bench.ts が使う） */
export function perfNext(): Promise<PerfResult> { return new Promise((r) => waiters.push(r)); }
const TIMEOUT_MS = 20000;

/** 流れを始める。前の流れが終わっていなければ、時間切れとして書き出してから始める */
export function perfStart(kind: FlowKind, id: string | null = null): Promise<PerfResult> {
  if (!ACTIVE) return new Promise(() => {});
  if (cur && !cur.done) perfEnd("superseded");
  let resolve!: (r: PerfResult) => void;
  const done = new Promise<PerfResult>((r) => { resolve = r; });
  const f: Flow = { kind, t0: performance.now(), id, marks: {}, pings: [], rafMax: 0, done: false, resolve };
  cur = f;
  probe(f);
  setTimeout(() => { if (cur === f && !f.done) perfEnd("timeout"); }, TIMEOUT_MS);
  return done;
}

/** 今の流れの対象のセッション。new では create の応答で分かる */
export function perfSetId(id: string) { if (cur && !cur.done) cur.id = id; }

/** 区間の印。同じ名前は最初の1回だけ残す。id を渡したときは、今の流れの対象と違えば捨てる */
export function perfMark(name: string, id?: string) {
  const f = cur;
  if (!f || f.done) return;
  if (id && f.id && f.id !== id) return;
  if (f.marks[name] == null) f.marks[name] = Math.round(performance.now() - f.t0);
}

/** 今の流れが、このセッションの入力欄（❯）を待っているか */
export function perfWaitingPrompt(id: string) { return !!cur && !cur.done && cur.id === id && cur.marks.prompt == null; }

export function perfEnd(reason = "ok") {
  const f = cur;
  if (!f || f.done) return;
  f.done = true;
  const s = [...f.pings].sort((a, b) => a - b);
  const r: PerfResult = {
    kind: f.kind, id: f.id, marks: { ...f.marks },
    ping: { n: s.length, p50: Math.round(s[Math.floor(s.length / 2)] ?? 0), max: Math.round(s[s.length - 1] ?? 0) },
    rafMax: Math.round(f.rafMax),
  };
  const line = JSON.stringify({ at: new Date().toISOString(), reason, ...r });
  console.info("[perf]", line);
  call("perf_log", { line }).catch(() => {});
  f.resolve(r);
  const w = waiters; waiters = [];
  for (const x of w) x(r);
}

/** 流れが終わるまで、perf_ping を続けて投げ（1本ずつ、待ってから次）、描画の間隔を見る */
function probe(f: Flow) {
  const ping = async () => {
    while (!f.done) {
      const t = performance.now();
      try { await call("perf_ping"); } catch { return; }
      f.pings.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  ping();
  let last = performance.now();
  const raf = (now: number) => {
    if (f.done) return;
    f.rafMax = Math.max(f.rafMax, now - last);
    last = now;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}
