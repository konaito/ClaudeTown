/** Rust の boot_status の done の1件（composer.rs の Sent）。error があれば送れなかった */
export type Done = { text: string; at: number; doneAt: number; error: string | null };

/** 送り終えた文の見分け。端末が無くなると同じ瞬間に全部 finish されるので、預かった時刻（at）も入れる */
export const doneKey = (sid: string, d: Done) => `${sid}|${d.at}|${d.doneAt}|${d.text}`;

/**
 * 送り終えた文を、届いた分と送れなかった分に分ける（純関数）。
 * 届いた分は、このパネルで扱った分（handled）を除く。handled が null なら開いた直後で、その時点の分は扱い済みにする（会話にもう出ている）。
 * 送れなかった分は、どこかで知らせた分（reported）だけを除く。開いた時点にあった分も、まだ知らせていなければ返す（#184）
 */
export function sortDone(sid: string, done: Done[], handled: ReadonlySet<string> | null, reported: ReadonlySet<string>) {
  const next = new Set(handled ?? done.filter((d) => !d.error).map((d) => doneKey(sid, d)));
  const delivered: Done[] = [];
  const failed: Done[] = [];
  for (const d of done) {
    const k = doneKey(sid, d);
    if (d.error) {
      if (!reported.has(k)) failed.push(d);
    } else if (!next.has(k)) {
      next.add(k);
      delivered.push(d);
    }
  }
  return { handled: next, delivered, failed };
}

// ---------- 預けた文の見張り（#184） ----------
//
// 起動を待って Rust が預かった文が送れなかったとき、どこかで1回だけ知らせる。
// 開いているパネル（useBoot）が読んでいるセッションはパネルが知らせ、それ以外は App の見張り（useQueuedWatch）が知らせる。
// 知らせ済みの集合はここに1つだけ持つ。Rust の done は残り続けるので、パネルの切り替えで消える場所に置くと、開き直すたびに同じ失敗が出る

/** 預けたセッションと、預けた時点の名前（claude が終わると一覧から消え、名前を引けなくなる） */
const watched = new Map<string, string>();
/** 開いているパネルが読んでいるセッション */
const owned = new Set<string>();
/** 知らせ済みの失敗（doneKey） */
const reported = new Set<string>();
/** 見張りが知らせた失敗の文。パネルでそのセッションを開いたら入力欄に戻す */
const returned = new Map<string, string[]>();

export const doneLog = {
  watch(sid: string, name: string) { watched.set(sid, name); },
  unwatch(sid: string) { watched.delete(sid); },
  watching(): [string, string][] { return [...watched]; },
  own(sid: string) { owned.add(sid); },
  release(sid: string) { owned.delete(sid); },
  ownedByPanel(sid: string) { return owned.has(sid); },
  reported: reported as ReadonlySet<string>,
  /** 知らせる分を知らせ済みにする。呼んだ側が知らせる */
  claim(sid: string, failed: Done[]) { for (const d of failed) reported.add(doneKey(sid, d)); },
  giveBack(sid: string, text: string) { returned.set(sid, [...(returned.get(sid) ?? []), text]); },
  takeBack(sid: string): string[] { const t = returned.get(sid) ?? []; returned.delete(sid); return t; },
};

/** トーストに出す文の頭 */
export const headOf = (text: string, n = 30) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** 見張りが読む boot_status の要るところ */
export type WatchStatus = { startedAt: number | null; queued: unknown[]; done: Done[] } | null;

/**
 * 見張りの1周（useQueuedWatch が WATCH_MS ごとに呼ぶ）。預けたセッションを読み、まだ知らせていない失敗を知らせる。
 * 開いているパネルが読んでいるセッションは飛ばす。端末が残っていて一覧にもいる子だけ、文を入力欄に戻す（いない子はチャットを開けない）。
 * 端末が残っているかは startedAt で見る（Rust の pty の台帳に無ければ null）。町の一覧は少し遅れて消えるので、一覧だけでは決めない。
 * 読めなかった（null）か、預かった文が無くなったら見張りから外す。stopped が true になったら途中でやめる
 */
export async function watchOnce(
  status: (sid: string) => Promise<WatchStatus>,
  toast: (text: string, bad?: boolean) => void,
  listed: (sid: string) => boolean,
  stopped: () => boolean = () => false,
) {
  for (const [id, name] of doneLog.watching()) {
    if (doneLog.ownedByPanel(id)) continue;
    let s: WatchStatus = null;
    try { s = await status(id); } catch { s = null; }
    if (stopped()) return;
    if (!s) { doneLog.unwatch(id); continue; }
    // 読んでいる間にパネルが開いたら、パネルに任せる
    if (doneLog.ownedByPanel(id)) continue;
    const { failed } = sortDone(id, s.done, null, doneLog.reported);
    doneLog.claim(id, failed);
    const alive = s.startedAt != null && listed(id);
    for (const d of failed) {
      if (alive) {
        doneLog.giveBack(id, d.text);
        toast(`${name} に届かなかった（「${headOf(d.text)}」）: ${d.error}。チャットを開くと入力欄に戻る`, true);
      } else {
        toast(`${name} に届かなかった: ${d.error}。送れなかった文:「${headOf(d.text, 80)}」`, true);
      }
    }
    if (s.queued.length === 0) doneLog.unwatch(id);
  }
}
