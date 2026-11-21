import { useEffect, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { ConvItem } from "../model";
import { answerPending, mergeConv, sameLive, settlePending, type ConvCache, type ConvDelta, type Live, type PendingItem } from "../conv";
import { pollBackoff } from "../visible";

const CONV_POLL_MS = 2500;

/** 会話に新しい発言が無い回が続いたときの間隔の上限（#5）。新しい発言が来るか、文を送ったら CONV_POLL_MS に戻す */
const CONV_POLL_MAX_MS = 10000;

/** 相手が作業中のあいだの会話の取り直しの間隔（#59）。延ばさずに、この間隔で取り続ける */
const CONV_POLL_LIVE_MS = 1000;

/**
 * 1つのセッションの会話の取得と表示の状態。id が変わると取り直す。
 * isFast は作業中でチャットを開いているか（取り直しの間隔を縮める）、working は作業中か。stick は会話の欄が一番下に付いているか（取り直すと一番下から始める）。
 * convKick は、会話をすぐ取り直させる口（文を送った直後に使う）
 */
export function useConversation(id: string | undefined, peer: string, isFast: boolean, working: boolean, stick: React.MutableRefObject<boolean>, echoesUser = true) {
  const [items, setItems] = useState<ConvItem[]>([]);
  // 今の動き（#59）。中身が変わったときだけ入れ替え、末尾の行のほかは描き直さない
  const [live, setLive] = useState<Live | null>(null);
  // 送ったばかりの文。after は送り始めたときに持っていた最後の番号で、これより後に届いた発言とだけ比べる
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [convErr, setConvErr] = useState<string | null>(null);
  // 保存してあった会話を出しているときの、保存した時刻。ccn から読めたら null に戻す
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const convKick = useRef<() => void>(() => {});
  const fast = useRef(false);
  fast.current = isFast;
  useEffect(() => { convKick.current(); }, [working, isFast]);
  useEffect(() => {
    setItems([]); setPending([]); setLive(null); setConvErr(null); setCachedAt(null); stick.current = true;
    if (!id) return;
    let alive = true;
    // ccn から一度でも読めたか。読めたあとに保存分が届いても出さない
    let live = false;
    // 画面が持っている数。Rust は、これより後の発言だけを返す（#10）。増えていなければ items を変えず、描き直さない。
    // 保存分を出している間は null のままにし、読めた最初の回は全部（reset）で差し替える（保存分の番号 n と混ぜない）
    let since: number | null = null;
    // 開いた直後に保存分を出す。ネットが切れていると ccn の時間切れまで数秒かかるので、失敗を待たない
    invoke<ConvCache | null>("conversation_cache", { sessionId: id, peer: peer || null }).then((c) => {
      if (!alive || live || !c?.items.length) return;
      setItems(c.items);
      setCachedAt(c.savedAt);
    }).catch(() => {});
    const load = async () => {
      try {
        const d = await invoke<ConvDelta>("conversation", { sessionId: id, peer: peer || null, since });
        if (!alive) return false;
        live = true;
        since = Math.max(since ?? 0, d.total);
        if (d.reset) since = d.total;
        setConvErr(null);
        setCachedAt(null);
        if (d.reset || d.items.length) setItems((prev) => mergeConv(prev, d));
        const nextLive = d.live ?? null;
        setLive((prev) => (sameLive(prev, nextLive) ? prev : nextLive));
        return d.reset || d.items.length > 0;
      } catch (e) {
        if (alive) setConvErr(String(e));
        return false;
      }
    };
    const p = pollBackoff(load, () => (fast.current ? CONV_POLL_LIVE_MS : CONV_POLL_MS), () => (fast.current ? CONV_POLL_LIVE_MS : CONV_POLL_MAX_MS));
    convKick.current = p.kick;
    return () => { alive = false; p.stop(); convKick.current = () => {}; };
  }, [id, peer]);

  // 送ったばかりの文は、送り始めたあとに会話に出たら仮の項目を消す（前の同じ文、「はい」や選択肢では消さない）。
  // 後に送った文が出たら、前に送った仮の項目も消す（#69、送った順と並びを入れ替えない）
  useEffect(() => { setPending((p) => { const s = settlePending(items, p); return echoesUser ? s : answerPending(items, s); }); }, [items, pending.length, echoesUser]);
  return { items, live, pending, setPending, convErr, cachedAt, convKick };
}
