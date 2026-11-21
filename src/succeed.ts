// 引き継ぎ。利用上限で止まったセッションの会話を複製して、同じ段（親なら世帯の親、子なら同じ親の下）に後継を立てる。
// 同じプロセスに文を送っても同じアカウントのままなので、上限の知らせを返し続ける。後継は ccn が作るときにアカウントを選び直す。
// ここは Tauri の命令を引数で受けるので、試験（src/succeed.test.ts）では偽の口を渡す。
//
// 作成の要求には、いつも succeed: true（resume と fork と一緒）を付ける。あとは応答で分ける。
// - 応答に succeeded がある（ccn の PR #56 から）: ccn が後継の起動を確かめ、前任の子を後継へ付け替え、前任を止めている。画面は結果を出すだけ
// - 応答に succeeded が無い（古い ccn）: ただの複製が返っている。後継が1通目を受け取るのを見てから、画面が前任だけを止める
// 先に版を聞かずに応答で分けるのは、ccn の HTTP の口が ccn の版を返さず（/api/host は claude の版だけ。MCP の名乗りの版は新旧とも 0.0.1）、
// 古い ccn は知らない項目を読まないため（下の実測）。応答の succeeded は、引き継ぎが行われたことそのものを示す。
// 分かれるのは応答の後なので、確認の文と後継への文は、どちらの ccn でも正しい文にしてある
//
// 2026-11-17 に確かめたこと（捨てのセッション、haiku。古い ccn は本番のノード、新しい ccn は main e6c5f87 の開発用ノード）:
// - 古い ccn: succeed: true を付けても、応答は 0.5 秒でただの複製（succeeded 無し）。前任は idle のまま、子の parent も変わらない
// - 古い ccn: 作成の応答は claude の起動の直後に state: running で返る。resume に失敗した claude はその後で落ちる
//   （応答から 5.7 秒後に exited、exitReason は "exit 1"）。立った後継は、1通目を受け取ると詳細の cursor が 1 以上になる（1〜7 秒）
// - 新しい ccn: 応答は 3.5〜5.4 秒。succeeded.adopted に子の id が入り、子の parent は後継の id に変わった。
//   後継の parent と depth は、呼び手（x-ccn-from）に関わらず前任のものになる。権限モード、モデル、--name も前任から継ぐ
// - 新しい ccn の断り方: 409 code: no_account（nextAvailable は { account, at（ms） } か null）、502 code: successor_failed（reason）、
//   409 code: already_succeeded（successor）。どれも前任と子には触らない
import type { Agent } from "./model";
import { canStop } from "./abilities";

/** 古い ccn で、後継が1通目を受け取るのを待つ上限（ms）。落ちる後継は 5.7 秒で落ちたので、その3倍より長く待つ */
export const SUCCEED_WAIT_MS = 20000;
/** 後継の様子を見る間隔（ms） */
export const SUCCEED_POLL_MS = 500;
/** 作成の応答が届かなかった後に、前任を読み直す回数と間隔（ms）。ccn の側では引き継ぎが進んでいることがあるので、少し待って確かめる */
export const SUCCEED_RECHECKS = 3;
export const SUCCEED_RECHECK_MS = 2000;

/** 前任の子。後継への文に名前と id を入れる。town は、別の町にいる子（転出のゴースト）のときの町の名前 */
export type Kid = { name: string; id: string; town?: string };

/**
 * 引き継げない理由。引き継げるなら null。local は、手元のノードの町を見ているか。
 * 待機かどうかは ccn の state で見る（返事待ちや完了の印は state が idle のまま付くので、気分では見ない）
 */
export function succeedBlock(a: Agent, local: boolean): string | null {
  if (!local) return "別の機械のセッションの引き継ぎは、まだ出していない";
  if (a.ghost) return "別の町にいるセッションは、その町で引き継ぐ";
  if (!canStop(a)) return "ccn から止められないセッションは引き継げない（前任を止められない）";
  if (a.state !== "idle") return "作業中か承認待ちのセッションは引き継げない。待機になってから引き継ぐ";
  // 親が転出のゴーストだと、親の ID は相手の町のもの。手元のノードの名前で親を名乗ると、木がつながらない
  if (a.parent?.startsWith("ghost:")) return "親が別の町にいるセッションの引き継ぎは、まだ出していない";
  return null;
}

/** 前任の子を、後継への文に入れる形にする。転出のゴーストは本物の ID と町の名前にする */
export function kidsOf(children: Agent[]): Kid[] {
  return children.map((k) => (k.ghost ? { name: k.name, id: k.ghost.realId, town: k.ghost.town } : { name: k.name, id: k.id }));
}

/** 後継の1通目。ccn が前に from の1行を付けて渡す。子の知らせの文は、ccn が子を付け替えても付け替えなくても正しい文にする */
export function handoffPrompt(o: { name: string; id: string; kids: Kid[] }): string {
  const lines = [
    `このセッションは、利用上限で止まった前任のセッション「${o.name}」（${o.id}）の会話を複製して立てた後継。本人が Claude Town で引き継ぎを押した。前任は引き継ぎと同時に止まる。`,
    "",
    "- この文より前の会話は、前任がしたもの。続きの作業は、このセッションが進める。",
    "- 前任が裏で回していた処理（バックグラウンドのコマンド、開発サーバー、見張りなど）は切れた前提で扱う。先に状態（git status、動いているプロセス、作りかけのファイル）を確かめてから、続きを進める。",
    "- セッション ID は前任と違う。自分の ID が要る所（ccn の as_session、担当の記録など）には、いまの $CLAUDE_CODE_SESSION_ID を使う。",
  ];
  if (o.kids.length) {
    const list = o.kids.map((k) => `「${k.name}」（${k.id}${k.town ? `、${k.town} にいる` : ""}）`).join("、");
    lines.push(`- 前任が立てた子が生きている: ${list}。ccn が子をこのセッションに付け替えていれば、子のターンが終わった知らせはここに届く。届かないとき（古い ccn、ノードを起動し直した後）は、子の様子を read_messages で自分から読む。`);
  }
  return lines.join("\n");
}

// ---------- ccn の断りを読む ----------

/** ccn が断ったときの中身。code は ccn の決めた名前（no_account、successor_failed、already_succeeded、succeeding、empty） */
export type CcnRefusal = {
  status?: number;
  code?: string;
  error?: string;
  /** already_succeeded: 続きを持っている後継の id */
  successor?: string;
  /** successor_failed: 後継が立たなかった理由（claude の終わり方） */
  reason?: string;
  /** no_account: 次に枠が空くアカウントと時刻（ms）。cam が答えなければ null */
  nextAvailable?: { account: string; at: number } | null;
};

/**
 * 命令の失敗の文から、ccn の断りを取り出す。ccn の断りでなければ（届かない、時間切れなど）null。
 * Rust の create_session は「ccn が <状態> を返した: <応答の JSON>」の形で失敗を返す（src-tauri/src/lib.rs）。ブラウザ表示のモックは JSON だけを投げる
 */
export function ccnRefusal(e: unknown): CcnRefusal | null {
  const text = e instanceof Error ? e.message : String(e);
  const from = text.indexOf("{"), to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  let v: unknown;
  try { v = JSON.parse(text.slice(from, to + 1)); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  const status = /ccn が (\d{3}) を返した/.exec(text)?.[1];
  const out: CcnRefusal = { status: status ? Number(status) : undefined, code: str(b.code), error: str(b.error), successor: str(b.successor), reason: str(b.reason) };
  if ("nextAvailable" in b) {
    const n = b.nextAvailable as Record<string, unknown> | null;
    out.nextAvailable = n && typeof n.account === "string" && typeof n.at === "number" ? { account: n.account, at: n.at } : null;
  }
  return out;
}

/** 時刻（ms）を「22:30」の形にする。今日でなければ日付を前に付ける（「11/18 03:10」） */
export function clockText(at: number, now: number): string {
  const d = new Date(at), n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 引き継ぎの失敗。kind が no_account のときは、画面が閉じるまで残る知らせで出す（次に空く時刻を読めるように） */
export class SucceedError extends Error {
  constructor(message: string, readonly kind: "no_account" | "other" = "other", readonly nextAvailable?: { account: string; at: number } | null) {
    super(message);
    this.name = "SucceedError";
  }
}

/** ccn の断りを、画面に出す文にする。前任と子に何が起きたかも書く。知らない断りは、ccn の文をそのまま出す */
export function refusalError(r: CcnRefusal, now: number): SucceedError {
  switch (r.code) {
    case "no_account": {
      const n = r.nextAvailable;
      const when = n ? `次に空くのは ${clockText(n.at, now)} ごろ（${n.account}）` : "次に空く時刻は分からなかった";
      return new SucceedError(`枠の残るアカウントが無いので、後継を立てなかった。${when}。前任は止めていない`, "no_account", n ?? null);
    }
    case "successor_failed":
      return new SucceedError(`後継が起動しなかった（${r.reason ?? "理由は不明"}）。前任と子はそのまま`);
    case "succeeding":
      return new SucceedError("いま引き継いでいる最中。少し待ってから町を見る");
    case "empty":
      return new SucceedError("まだ会話が無いセッションなので、引き継ぐものが無い");
    default:
      return new SucceedError(r.error ? `ccn が断った${r.status ? `（${r.status}）` : ""}: ${r.error}` : "ccn が断った");
  }
}

/** 前任の終わりの理由（succeeded: continued as <id>）から、後継の id を読む。引き継がれて止まったのでなければ null */
export function successorIn(exitReason: unknown): string | null {
  const m = typeof exitReason === "string" ? /^succeeded: continued as ([0-9a-f][0-9a-f-]{7,35})/i.exec(exitReason) : null;
  return m ? m[1] : null;
}

// ---------- 後継を立てる ----------

export type SucceedDeps = {
  /** Tauri の命令（session_detail、create_session、stop_session）を呼ぶ口 */
  call: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * kind が ccn: ccn が引き継いだ。stopped は前任が止まったか（false なら note に理由。画面が自分で止める）、adopted は後継に付け替えた子の id。
 *   already は、この要求より前に引き継ぎが済んでいた（二度押し、時間切れの後の送り直し）。
 * kind が took: 古い ccn で、後継が1通目を受け取った。画面が前任を止める。
 * kind が waiting: 古い ccn で、後継は生きているが、上限まで待っても1通目を受け取らなかった（端末で確認の画面に止まっている、など）。前任は止めない。
 * depth は作成の応答の値。depthChecked は、前任の depth と比べられたか（古い ccn を起動し直した後などは、前任の depth が詳細に無い）
 */
export type Started = { id: string; cwd: string; account?: string | null } & (
  | { kind: "ccn"; stopped: boolean; note?: string; adopted: string[]; already?: boolean }
  | { kind: "took" | "waiting"; depth: number | null; depthChecked: boolean }
);

type Detail = { state?: string; depth?: unknown; title?: unknown; cursor?: unknown; exitReason?: unknown } | null;
type Created = { id?: string; cwd?: string; depth?: unknown; account?: unknown; succeeded?: unknown } | null;

/**
 * 後継を立てる。ccn が引き継ぎまで行ったか（ccn）、画面が続きを行うか（took、waiting）を返す。
 * 立たなかったら SucceedError を投げる。このとき前任は止まっていない。古い ccn で深さが前任と違う後継は、ここで止めてから投げる。
 */
export async function startSuccessor(o: { agent: Agent; kids: Kid[]; cols: number | null; rows: number | null }, d: SucceedDeps): Promise<Started> {
  const a = o.agent;
  const detail = (id: string) => d.call<Detail>("session_detail", { sessionId: id, peer: null });
  /** 済んでいた引き継ぎ。後継の id だけが分かる */
  const done = (id: string, already: boolean): Started => ({ kind: "ccn", id, cwd: a.cwd, stopped: true, adopted: [], already });
  // 確認を出している間に動き出していないか、ccn の今の値で見直す
  const before = await detail(a.id);
  if (before?.state === "exited") {
    const succ = successorIn(before.exitReason);
    if (succ) return done(succ, true);
    throw new SucceedError("もう止まっている");
  }
  if (before?.state !== "idle") throw new SucceedError("作業中か承認待ちになった。待機になってから引き継ぐ");
  const title = typeof before.title === "string" && before.title.trim() ? before.title : null;
  let r: Created;
  try {
    r = await d.call<Created>("create_session", {
      // 会話の記録は cwd ごとの場所にあるので、前任と同じ cwd で立てる。親を渡すと、古い ccn ではその親の子として立つ
      // （新しい ccn は、渡した親に関わらず前任の parent を継がせる）
      cwd: a.cwd, prompt: handoffPrompt({ name: a.name, id: a.id, kids: o.kids }), parent: a.parent, name: title,
      cols: o.cols, rows: o.rows, peer: null, resume: a.id, fork: true, succeed: true,
    });
  } catch (e) {
    const no = ccnRefusal(e);
    if (no?.code === "already_succeeded" && no.successor) return done(no.successor, true);
    // ccn が断った。前任と子には触っていない
    if (no) throw refusalError(no, d.now());
    // ccn の答えが届かなかった（時間切れ、つながらない）。ccn の側では引き継ぎが進んでいることがあるので、前任を数回読んで確かめる。
    // 引き継がれて止まっていれば、成功として扱う
    for (let i = 0; i < SUCCEED_RECHECKS; i++) {
      if (i > 0) await d.sleep(SUCCEED_RECHECK_MS);
      const after = await detail(a.id).catch(() => null);
      const succ = successorIn(after?.exitReason);
      if (after?.state === "exited" && succ) return done(succ, false);
    }
    throw new SucceedError(e instanceof Error ? e.message : String(e));
  }
  if (!r?.id || r.id === a.id) throw new SucceedError("ccn が後継の ID を返さなかった");
  const id = r.id;
  const base = { id, cwd: r.cwd ?? a.cwd, account: typeof r.account === "string" && r.account ? r.account : null };
  if (r.succeeded && typeof r.succeeded === "object") {
    // 新しい ccn。後継の起動、子の付け替え、前任の停止まで済んでいる
    const s = r.succeeded as { stopped?: unknown; note?: unknown; adopted?: unknown };
    return {
      kind: "ccn", ...base, stopped: s.stopped === true, note: typeof s.note === "string" && s.note ? s.note : undefined,
      adopted: Array.isArray(s.adopted) ? s.adopted.filter((x): x is string => typeof x === "string") : [],
    };
  }
  // 古い ccn。ここから先は画面が進める
  const want = typeof before.depth === "number" ? before.depth : null;
  const got = typeof r.depth === "number" ? r.depth : null;
  if (want !== null && got !== null && want !== got) {
    const stopped = await d.call("stop_session", { sessionId: id, peer: null }).then(() => true, () => false);
    throw new SucceedError(`後継の深さ（${got}）が前任（${want}）と違った。${stopped ? "後継は止めた" : `後継（${id.slice(0, 8)}）を止められなかったので、手で閉じる`}`);
  }
  const out = { ...base, depth: got, depthChecked: want !== null && got !== null };
  const end = d.now() + SUCCEED_WAIT_MS;
  for (;;) {
    await d.sleep(SUCCEED_POLL_MS);
    // 1回読めなくても、次の回で見る
    const s = await detail(id).catch(() => null);
    if (s?.state === "exited") throw new SucceedError(`後継が起動しなかった（${typeof s.exitReason === "string" && s.exitReason ? s.exitReason : "理由は不明"}）`);
    if (s && typeof s.cursor === "number" && s.cursor > 0) return { kind: "took", ...out };
    if (d.now() >= end) return { kind: "waiting", ...out };
  }
}
