// / の候補にするスキルとコマンドの一覧（Rust の slash_commands が読む）を、作業フォルダごとに覚えておく。
// 起動した後に ~/.claude/skills へ足したスキルも出すため、頼まれるたびに読み直す（#315）。いつ頼むかは useCompletion が決める。
// 読み直しが届くまでは前の一覧を出し、読んでいる最中に重ねて頼まれても Rust は1回だけ呼ぶ。
import type { Command } from "./commands";

const EMPTY: Command[] = [];

const same = (a: Command[], b: Command[]) =>
  a.length === b.length && a.every((c, i) => JSON.stringify(c) === JSON.stringify(b[i]));

export function skillStore(load: (cwd: string) => Promise<Command[]>) {
  const lists = new Map<string, Command[]>();
  const pending = new Map<string, Promise<void>>();
  const subs = new Set<() => void>();
  return {
    get: (cwd: string): Command[] => lists.get(cwd) ?? EMPTY,
    has: (cwd: string) => lists.has(cwd),
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    /** 一覧を読み直す。中身が変わったときだけ知らせる（開いている候補の並びと選択を動かさないため） */
    refresh(cwd: string): Promise<void> {
      const now = pending.get(cwd);
      if (now) return now;
      // load が同期で投げても pending に残らないよう、次の順番で呼ぶ
      const p = Promise.resolve().then(() => load(cwd)).then((l) => {
        if (!Array.isArray(l)) return;
        const old = lists.get(cwd);
        if (old && same(old, l)) return;
        lists.set(cwd, l);
        subs.forEach((f) => f());
      }, () => { /* 読めなければ前の一覧のまま */ }).finally(() => { pending.delete(cwd); });
      pending.set(cwd, p);
      return p;
    },
  };
}

/** 開いている候補の並びが替わったとき、選んでいたコマンドの新しい番号。見つからなければ先頭、元から選んでいなければ null（動かさない） */
export function repick(prev: Command[], pick: number, next: Command[]): number | null {
  const was = prev[pick];
  if (!was) return null;
  const i = next.findIndex((c) => c.source === was.source && c.name === was.name);
  return i >= 0 ? i : 0;
}
