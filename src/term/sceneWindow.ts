// ?bench=scene の、数える区間と割る秒数を決める部分（#216）。
// bench.ts は React と bridge を読むので、試験から読めるように import の無いこのファイルに出した。
// 時計、IPC と文字の数、待ち、fps の計測は引数で渡す。

export type SceneCounts = { ipc: number; bytes: number };
export type SceneIO = {
  now: () => number;
  counts: () => SceneCounts;
  sleep: (ms: number) => Promise<unknown>;
  fps: (ms: number) => Promise<number>;
};

/**
 * ready を書き、wait のあいだ IPC の回数と文字数を数えて、1秒あたりに直す。
 * ready は fps を測る関数を受け取り、記録を書く。end は待ちの終わりの時点で取る値（at や vis）を返す。
 * 戻り値は end の値に、待ちの後の fps、ipcPerSec、charsPerSec を足したもの。
 */
export async function measureScene<E extends object>(
  io: SceneIO,
  wait: number,
  ready: (fps: () => Promise<number>) => Promise<unknown>,
  end: () => E,
): Promise<E & { fps: number; ipcPerSec: number; charsPerSec: number }> {
  // ready の fps と記録が済んでから、数え始めの値と時刻を await を挟まずに取る
  await ready(() => io.fps(1000));
  const c0 = io.counts(), t0 = io.now();
  await io.sleep(wait);
  // 待ちの直後に、終わりの値と時刻を await を挟まずに取る。後の fps の1秒は数えない
  const c1 = io.counts(), secs = (io.now() - t0) / 1000;
  const e = end();
  const fps = await io.fps(1000);
  return { ...e, fps, ipcPerSec: +((c1.ipc - c0.ipc) / secs).toFixed(1), charsPerSec: Math.round((c1.bytes - c0.bytes) / secs) };
}
