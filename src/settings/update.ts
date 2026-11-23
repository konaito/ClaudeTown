// 安定版の更新（#295）。Rust の update_status、update_run（src-tauri/src/update.rs）の形と、画面に出す文の決め方。
// 欄と点を出さない版（開発版、ブラウザ版）では update_status が null を返す。
import { useEffect, useState } from "react";
import { call as invoke } from "../bridge";
import { pollWhileVisible } from "../visible";

export type UpdateCompare = { kind: "same" } | { kind: "ahead"; n: number } | { kind: "diverged" };
export type UpdateRun =
  | { state: "idle" }
  | { state: "running"; startedAt: number }
  | { state: "finished"; ok: boolean; code: number | null; at: string; tail: string[] };

export type UpdateStatus = {
  repo: string;
  branch: string;
  current: { tag: string; sha: string } | null;
  currentError: string | null;
  remote: string | null;
  compare: UpdateCompare | null;
  compareError: string | null;
  /** origin/main が今の版の子孫で、同じでない */
  available: boolean;
  checkedAt: number | null;
  checkError: string | null;
  checking: boolean;
  run: UpdateRun;
};

/** 届いた値が update_status の形か。ブラウザ表示の仮の返事（文字列）などは null にする */
export function asStatus(v: unknown): UpdateStatus | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<UpdateStatus>;
  return typeof s.available === "boolean" && s.run && typeof s.run === "object" ? (s as UpdateStatus) : null;
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");

/** 歯車に点を付けるか。更新があって、走らせていないとき */
export const showDot = (s: UpdateStatus | null) => !!s && s.available && s.run.state !== "running";

/** 「更新して再起動」を押せるか。更新があって、走っておらず、押した返事を待っていないとき */
export const canRun = (s: UpdateStatus | null, pressing: boolean) => !!s && s.available && s.run.state !== "running" && !pressing;

/** 今の版と origin/main の関係を1行で */
export function compareText(s: UpdateStatus): string {
  if (s.currentError) return s.currentError;
  if (s.compareError) return s.compareError;
  const c = s.compare;
  if (!c) return "まだ比べていない";
  if (c.kind === "same") return "最新";
  if (c.kind === "ahead") return `${c.n} コミット新しい版がある`;
  return `${s.branch} が今の版の子孫ではないので、更新とはみなさない`;
}

/** 最後に確かめた時刻の文。at は ms、now も ms */
export function checkedText(s: UpdateStatus, now: number): string {
  if (s.checking) return "確かめている…";
  if (s.checkError) return `確かめられなかった: ${s.checkError}`;
  if (s.checkedAt == null) return "まだ fetch していない";
  const min = Math.floor((now - s.checkedAt) / 60_000);
  return min < 1 ? "1分以内に確かめた" : `${min}分前に確かめた`;
}

/** ボタンの下に出す、走らせた更新の文。出さないときは null */
export function runText(r: UpdateRun): { text: string; bad: boolean } | null {
  if (r.state === "idle") return null;
  if (r.state === "running") return { text: "更新している。ビルドに数分かかり、済むとアプリが終わって新しい版で起動し直す", bad: false };
  const when = r.at ? `（${r.at}）` : "";
  if (r.ok) return { text: `前回の更新は済んだ${when}`, bad: false };
  return { text: `前回の更新は失敗した${when}。終了コード ${r.code ?? "なし"}`, bad: true };
}

/**
 * update_status を ms ごとに読む（窓が見えている間だけ）。refresh なら、最初の1回で裏の fetch も始める。
 * 欄と点を出さない版では null のまま
 */
export function useUpdateStatus(ms: number, refresh = false) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let live = true;
    let first = refresh;
    const load = () => {
      const r = first;
      first = false;
      invoke<unknown>("update_status", { refresh: r })
        .then((v) => live && setSt(asStatus(v)))
        .catch(() => { /* 読めないときは前の値のまま */ });
    };
    const stop = pollWhileVisible(load, ms);
    return () => { live = false; stop(); };
  }, [ms, refresh]);
  return [st, setSt] as const;
}
