// 引き継ぎ。利用上限で止まったセッションの会話を複製して、同じ段（親なら根、子なら同じ親の下）に後継を立てる。
// 同じプロセスに文を送っても同じアカウントのままなので、上限の知らせを返し続ける。後継は ccn が作るときにアカウントを選び直す。
// 画面の順（App.tsx の succeed）: 確認 → startSuccessor（ここ）→ 後継が文を受け取っていたら前任だけを止める。
// ここは Tauri の命令を引数で受けるので、試験（src/succeed.test.ts）では偽の口を渡す。
//
// 2026-11-17 に手元の ccn で確かめたこと（捨てのセッション、haiku）:
// - POST /api/sessions に resume と fork を渡すと、新しい id で立ち、前の会話を覚えている。depth と parent は呼び手（x-ccn-from）で決まる
// - 作成の応答は claude の起動の直後に state: running で返る。resume に失敗した claude はその後で落ちる
//   （存在しない id で、応答から 5.7 秒後に exited、exitReason は "exit 1"）。応答だけでは、後継が立ったかは分からない
// - 立った後継は、1通目を受け取ると詳細の cursor（台帳の末尾）が 1 以上になる（2〜7 秒）
import type { Agent } from "./model";

/** 後継が1通目を受け取るのを待つ上限（ms）。落ちる後継は 5.7 秒で落ちたので、その3倍より長く待つ */
export const SUCCEED_WAIT_MS = 20000;
/** 後継の様子を見る間隔（ms） */
export const SUCCEED_POLL_MS = 500;

/** 前任の子。後継への文に名前と id を入れる。town は、別の町にいる子（転出のゴースト）のときの町の名前 */
export type Kid = { name: string; id: string; town?: string };

/**
 * 引き継げない理由。引き継げるなら null。local は、手元のノードの町を見ているか。
 * 待機かどうかは ccn の state で見る（返事待ちや完了の印は state が idle のまま付くので、気分では見ない）
 */
export function succeedBlock(a: Agent, local: boolean): string | null {
  if (!local) return "別の機械のセッションの引き継ぎは、まだ出していない";
  if (a.ghost) return "別の町にいるセッションは、その町で引き継ぐ";
  if (!a.capabilities?.stop) return "ccn から止められないセッションは引き継げない（前任を止められない）";
  if (a.state !== "idle") return "作業中か承認待ちのセッションは引き継げない。待機になってから引き継ぐ";
  // 親が転出のゴーストだと、親の ID は相手の町のもの。手元のノードの名前で親を名乗ると、木がつながらない
  if (a.parent?.startsWith("ghost:")) return "親が別の町にいるセッションの引き継ぎは、まだ出していない";
  return null;
}

/** 前任の子を、後継への文に入れる形にする。転出のゴーストは本物の ID と町の名前にする */
export function kidsOf(children: Agent[]): Kid[] {
  return children.map((k) => (k.ghost ? { name: k.name, id: k.ghost.realId, town: k.ghost.town } : { name: k.name, id: k.id }));
}

/** 後継の1通目。ccn が前に from の1行を付けて渡す */
export function handoffPrompt(o: { name: string; id: string; kids: Kid[] }): string {
  const lines = [
    `このセッションは、利用上限で止まった前任のセッション「${o.name}」（${o.id}）の会話を複製して立てた後継。本人が Claude Town で引き継ぎを押した。前任はこのあと止まる。`,
    "",
    "- ここまでの会話は前任のもの。続きの作業は、このセッションが進める。",
    "- 前任が裏で回していた処理（バックグラウンドのコマンド、開発サーバー、見張りなど）は切れた前提で扱う。先に状態（git status、動いているプロセス、作りかけのファイル）を確かめてから、続きを進める。",
    "- セッション ID は前任と違う。自分の ID が要る所（ccn の as_session、担当の記録など）には、いまの $CLAUDE_CODE_SESSION_ID を使う。",
  ];
  if (o.kids.length) {
    const list = o.kids.map((k) => `「${k.name}」（${k.id}${k.town ? `、${k.town} にいる` : ""}）`).join("、");
    lines.push(`- 前任が立てた子が生きている: ${list}。子のターンが終わった知らせは前任の ID 宛てなので、このセッションには届かない。子の様子は read_messages で自分から読む。`);
  }
  return lines.join("\n");
}

export type SucceedDeps = {
  /** Tauri の命令（session_detail、create_session、stop_session）を呼ぶ口 */
  call: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * took: 後継が1通目を受け取った。前任を止めてよい。
 * waiting: 後継は生きているが、上限まで待っても1通目を受け取らなかった（端末で確認の画面に止まっている、など）。前任は止めない。
 * depth は作成の応答の値。depthChecked は、前任の depth と比べられたか（ccn を再起動した後などは、前任の depth が詳細に無い）
 */
export type Started = { kind: "took" | "waiting"; id: string; cwd: string; depth: number | null; depthChecked: boolean };

type Detail = { state?: string; depth?: unknown; title?: unknown; cursor?: unknown; exitReason?: unknown } | null;

/**
 * 後継を立てて、1通目を受け取るまで見る。前任は止めない（止めるのは呼び手。took のときだけ）。
 * 立たなかったら投げる。このとき前任には何もしていない。深さが前任と違う後継は、ここで止めてから投げる。
 */
export async function startSuccessor(o: { agent: Agent; kids: Kid[]; cols: number | null; rows: number | null }, d: SucceedDeps): Promise<Started> {
  const a = o.agent;
  // 確認を出している間に動き出していないか、ccn の今の値で見直す
  const before = await d.call<Detail>("session_detail", { sessionId: a.id, peer: null });
  if (before?.state === "exited") throw new Error("もう止まっている");
  if (before?.state !== "idle") throw new Error("作業中か承認待ちになった。待機になってから引き継ぐ");
  const title = typeof before.title === "string" && before.title.trim() ? before.title : null;
  const r = await d.call<{ id?: string; cwd?: string; depth?: unknown } | null>("create_session", {
    // 会話の記録は cwd ごとの場所にあるので、前任と同じ cwd で立てる。親を渡すと、その親の子として立つ
    cwd: a.cwd, prompt: handoffPrompt({ name: a.name, id: a.id, kids: o.kids }), parent: a.parent, name: title,
    cols: o.cols, rows: o.rows, peer: null, resume: a.id, fork: true,
  });
  if (!r?.id || r.id === a.id) throw new Error("ccn が後継の ID を返さなかった");
  const id = r.id;
  const want = typeof before.depth === "number" ? before.depth : null;
  const got = typeof r.depth === "number" ? r.depth : null;
  if (want !== null && got !== null && want !== got) {
    const stopped = await d.call("stop_session", { sessionId: id, peer: null }).then(() => true, () => false);
    throw new Error(`後継の深さ（${got}）が前任（${want}）と違った。${stopped ? "後継は止めた" : `後継（${id.slice(0, 8)}）を止められなかったので、手で閉じる`}`);
  }
  const out = { id, cwd: r.cwd ?? a.cwd, depth: got, depthChecked: want !== null && got !== null };
  const end = d.now() + SUCCEED_WAIT_MS;
  for (;;) {
    await d.sleep(SUCCEED_POLL_MS);
    // 1回読めなくても、次の回で見る
    const s = await d.call<Detail>("session_detail", { sessionId: id, peer: null }).catch(() => null);
    if (s?.state === "exited") throw new Error(`後継が起動しなかった（${typeof s.exitReason === "string" && s.exitReason ? s.exitReason : "理由は不明"}）`);
    if (s && typeof s.cursor === "number" && s.cursor > 0) return { kind: "took", ...out };
    if (d.now() >= end) return { kind: "waiting", ...out };
  }
}
