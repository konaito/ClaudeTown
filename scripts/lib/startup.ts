// 起動の時間の区間（#187、#16）。scripts/bench.ts の startup の場面が、開発版の記録（FC_PERF_LOG）から作る。
// bench.ts は読むだけでロックや起動が走るので、試験から読めるように区間の計算だけをこのファイルに出した。
//
// 始点はどれも Rust の run() の入口（lib.rs が書く {"bench":"proc","procStartMs"}）。exec と dyld の時間は入らない。
// 終点は画面（src/term/bench.ts の scene）が ready の行に書く時刻。
//   navStartMs      WebView が画面の読み込みを始めた時刻（performance.timeOrigin）
//   shellPaintedAt  App の最初のコミット（町の枠だけで、一覧はまだ）の後の最初の requestAnimationFrame。窓の最初の描画とみなす
//   paintedAt       一覧が届いて町を描いた後の最初の requestAnimationFrame。ほかの場面の startupMs と同じ
// 窓が隠れていると rAF が止まり、shellPaintedAt と paintedAt は 0 のまま来る。そのときは無効にする。

export type ProcLine = { procStartMs?: number };
export type ReadyLine = { navStartMs?: number; shellPaintedAt?: number; paintedAt?: number; vis?: string | null };
export type StartupSpans = { toNavStartMs: number | null; toShellPaintMs: number | null; toTownPaintMs: number | null };

const span = (from: number | undefined, to: number | undefined) =>
  typeof from === "number" && from > 0 && typeof to === "number" && to > 0 ? to - from : null;

/** 区間と、無効の理由（有効なら空）を返す */
export function startupSpans(proc: ProcLine | undefined, ready: ReadyLine): { spans: StartupSpans; bad: string[] } {
  const p = proc?.procStartMs;
  const spans: StartupSpans = {
    toNavStartMs: span(p, ready.navStartMs),
    toShellPaintMs: span(p, ready.shellPaintedAt),
    toTownPaintMs: span(p, ready.paintedAt),
  };
  const bad: string[] = [];
  if (!p) bad.push("Rust の起動の時刻（procStartMs）が無い");
  if (ready.vis !== "visible") bad.push(`窓が見えていない（${ready.vis ?? "?"}）`);
  if (!ready.shellPaintedAt) bad.push("窓の最初の描画の時刻が無い");
  if (!ready.paintedAt) bad.push("町の最初の描画の時刻が無い");
  // 順番が逆なら、時計か印の付け方がおかしい
  const { toShellPaintMs: a, toTownPaintMs: b } = spans;
  if (a != null && b != null && a > b) bad.push(`窓の描画（${a}ms）が町の描画（${b}ms）より後`);
  if (Object.values(spans).some((x) => x != null && x < 0)) bad.push("起動より前の時刻がある");
  return { spans, bad };
}
