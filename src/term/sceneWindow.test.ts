import { describe, expect, test } from "bun:test";
import { measureScene } from "./sceneWindow";

// 偽の時計。sleep と fps は時計を進める。IPC は1秒に10回、文字は1秒に100字、時刻に比例して増える。
// counts() を読んだ時刻を残す
const fake = () => {
  let t = 0;
  const reads: number[] = [];
  const io = {
    now: () => t,
    counts: () => { reads.push(t); return { ipc: t / 100, bytes: t / 10 }; },
    sleep: async (ms: number) => { t += ms; },
    fps: async (ms: number) => { t += ms; return 60; },
  };
  // ready の記録も時間を使う（perf_log の往復）
  const ready = async (fps: () => Promise<number>) => { t += 50; await fps(); t += 50; };
  return { io, reads, ready, now: () => t };
};

describe("scene の場面の ipcPerSec と charsPerSec（#216）", () => {
  test("数える区間は wait と同じ長さ（ready と後の fps の時間を含めない）", async () => {
    const f = fake();
    await measureScene(f.io, 65000, f.ready, () => ({}));
    expect(f.reads.length).toBe(2);
    expect(f.reads[1] - f.reads[0]).toBe(65000);
  });

  test("一定の速さなら、その速さがそのまま出る", async () => {
    const f = fake();
    const r = await measureScene(f.io, 65000, f.ready, () => ({}));
    expect(r.ipcPerSec).toBe(10);
    expect(r.charsPerSec).toBe(100);
    expect(r.fps).toBe(60);
  });

  test("end は待ちの終わりの時点で呼ぶ（後の fps の前）", async () => {
    const f = fake();
    const r = await measureScene(f.io, 65000, f.ready, () => ({ at: f.now() }));
    // ready に 1100ms、待ちに 65000ms
    expect(r.at).toBe(66100);
  });
});
