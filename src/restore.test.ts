import { describe, expect, test } from "bun:test";
import { createVisibility } from "./visible";
import { restoreNotice, watchRestore, type Lost, type RestoreReport } from "./restore";

/** visible.ts の見え方を、watchRestore が受ける形にする */
const visOf = (v: ReturnType<typeof createVisibility>) => ({ isVisible: v.isVisible, onVisibleChange: v.subscribe });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lost = (over: Partial<Lost>): Lost => ({ id: "11111111-1111-4111-8111-111111111111", cwd: "/Users/me/Documents/app", name: null, reason: "会話の記録（jsonl）が無い", retry: false, ...over });

describe("restoreNotice（#262）", () => {
  test("戻らなかった端末が無ければ知らせない", () => {
    expect(restoreNotice([])).toBeNull();
  });

  test("名前（無ければ場所の名前）と理由を並べ、起動に失敗したものは次の起動で試すと書く", () => {
    const t = restoreNotice([
      lost({ name: "調べ物", reason: "よそで同じ id のセッションが動いている" }),
      lost({ cwd: "/Users/me/Documents/web", reason: "claude を起動できなかった", retry: true }),
    ]);
    expect(t).toBe("前回の端末のうち2件を戻せなかった。調べ物（よそで同じ id のセッションが動いている）、web（claude を起動できなかった。次の起動でもう一度試す）");
  });

  test("4件より多いときは3件だけ並べ、残りを数で書く", () => {
    const t = restoreNotice(["a", "b", "c", "d", "e"].map((n) => lost({ name: n })));
    expect(t).toBe("前回の端末のうち5件を戻せなかった。a（会話の記録（jsonl）が無い）、b（会話の記録（jsonl）が無い）、c（会話の記録（jsonl）が無い）、ほか2件");
  });
});

describe("watchRestore（#262）", () => {
  test("済むまで取りに行き、済んだら1回だけ知らせる", async () => {
    const answers: RestoreReport[] = [{ done: false, lost: [] }, { done: true, lost: [lost({ name: "x" })] }];
    let calls = 0;
    const shown: string[] = [];
    watchRestore(async () => answers[Math.min(calls++, 1)], (t) => shown.push(t), visOf(createVisibility(true)));
    await wait(20);
    expect(calls).toBe(2);
    expect(shown).toEqual(["前回の端末のうち1件を戻せなかった。x（会話の記録（jsonl）が無い）"]);
  });

  test("戻らなかった端末が無ければ知らせない", async () => {
    const shown: string[] = [];
    watchRestore(async () => ({ done: true, lost: [] }), (t) => shown.push(t), visOf(createVisibility(true)));
    await wait(20);
    expect(shown).toEqual([]);
  });

  test("窓が隠れている間は出さず、見えてから出す（隠れたまま出すと、本人が見る前に消える）", async () => {
    const v = createVisibility(false);
    const shown: string[] = [];
    watchRestore(async () => ({ done: true, lost: [lost({ name: "x" })] }), (t) => shown.push(t), visOf(v));
    await wait(20);
    expect(shown).toEqual([]);
    v.set(true);
    v.set(false);
    v.set(true);
    expect(shown.length).toBe(1);
  });

  test("止めた後に済んでも知らせない（開発の StrictMode で effect が2回走るとき、2回出さない）", async () => {
    let release: (r: RestoreReport) => void = () => {};
    const shown: string[] = [];
    const stop = watchRestore(() => new Promise((r) => { release = r; }), (t) => shown.push(t), visOf(createVisibility(true)));
    stop();
    release({ done: true, lost: [lost({ name: "x" })] });
    await wait(20);
    expect(shown).toEqual([]);
  });

  test("命令が失敗したら（古い Rust など）知らせずに終える", async () => {
    let calls = 0;
    const shown: string[] = [];
    watchRestore(async () => { calls++; throw new Error("command restore_report not found"); }, (t) => shown.push(t), visOf(createVisibility(true)));
    await wait(20);
    expect(calls).toBe(1);
    expect(shown).toEqual([]);
  });
});
