import { useCallback, useEffect, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { ConvItem } from "../model";
import { addPending, answerPending, convFailed, dropPending, mergeConv, pendingOf, sameLive, settlePending, updatePending, type ConvDelta, type Live, type PendingBy, type PendingItem } from "../conv";
import { pollBackoff } from "../visible";

const CONV_POLL_MS = 2500;

/** 会話に新しい発言が無い回が続いたときの間隔の上限（#5）。新しい発言が来るか、文を送ったら CONV_POLL_MS に戻す */
const CONV_POLL_MAX_MS = 10000;

/** 相手が作業中のあいだの会話の取り直しの間隔（#59）。延ばさずに、この間隔で取り続ける */
const CONV_POLL_LIVE_MS = 1000;

/**
 * 1つのセッションの会話の取得と表示の状態。id が変わると取り直す。
 * isFast は作業中でチャットを開いているか（取り直しの間隔を縮める）、working は作業中か。stick は会話の欄が一番下に付いているか（取り直すと一番下から始める）。
 * convKick は、会話をすぐ取り直させる口（文を送った直後に使う）。
 * addPending は、送ったばかりの文を送った先の id の一覧に足す口（#178）。送っている間に id が替わっても、今の会話には足さない
 */
export function useConversation(id: string | undefined, isFast: boolean, working: boolean, stick: React.MutableRefObject<boolean>, echoesUser = true) {
  const [items, setItems] = useState<ConvItem[]>([]);
  // items がどの id のものか（#178）。id が替わった最初の描画では items はまだ前の id のものなので、その間は仮の項目と突き合わせない
  const [itemsOf, setItemsOf] = useState<string | undefined>(undefined);
  // 今の動き（#59）。中身が変わったときだけ入れ替え、末尾の行のほかは描き直さない
  const [live, setLive] = useState<Live | null>(null);
  // 送ったばかりの文を、送った先の id ごとに持つ（#178）。after は送り始めたときに持っていた最後の番号で、これより後に届いた発言とだけ比べる
  const [pendingBy, setPendingBy] = useState<PendingBy>({});
  const pending = pendingOf(pendingBy, id);
  const [convErr, setConvErr] = useState<string | null>(null);
  const convKick = useRef<() => void>(() => {});
  const fast = useRef(false);
  fast.current = isFast;
  useEffect(() => { convKick.current(); }, [working, isFast]);
  useEffect(() => {
    setItems([]); setItemsOf(id); setLive(null); setConvErr(null); stick.current = true;
    if (!id) return;
    let alive = true;
    // 画面が持っている数。Rust は、これより後の発言だけを返す（#10）。増えていなければ items を変えず、描き直さない
    let since: number | null = null;
    // 続けて失敗した回数。1回の失敗では印を出さず、成功したら戻す
    let failures = 0;
    const load = async () => {
      try {
        const d = await invoke<ConvDelta>("conversation", { sessionId: id, since });
        if (!alive) return false;
        since = Math.max(since ?? 0, d.total);
        if (d.reset) since = d.total;
        failures = 0;
        setConvErr(null);
        if (d.reset || d.items.length) setItems((prev) => mergeConv(prev, d));
        const nextLive = d.live ?? null;
        setLive((prev) => (sameLive(prev, nextLive) ? prev : nextLive));
        return d.reset || d.items.length > 0;
      } catch (e) {
        failures += 1;
        if (alive && convFailed(failures)) setConvErr(String(e));
        return false;
      }
    };
    const p = pollBackoff(load, () => (fast.current ? CONV_POLL_LIVE_MS : CONV_POLL_MS), () => (fast.current ? CONV_POLL_LIVE_MS : CONV_POLL_MAX_MS));
    convKick.current = p.kick;
    // 離れるときに、その id の仮の項目を捨てる（これまでと同じく、選び直したら空から始める）。
    // 送っている間に離れたときは、この後に送った先の id へ足されるので、戻ったときに出て、会話に出たら消える
    return () => { alive = false; p.stop(); convKick.current = () => {}; setPendingBy((b) => dropPending(b, id)); };
  }, [id]);

  // 送ったばかりの文は、送り始めたあとに会話に出たら仮の項目を消す（前の同じ文、「はい」や選択肢では消さない）。
  // 後に送った文が出たら、前に送った仮の項目も消す（#69、送った順と並びを入れ替えない）
  useEffect(() => {
    if (!id || itemsOf !== id) return;
    setPendingBy((b) => updatePending(b, id, (p) => { const s = settlePending(items, p); return echoesUser ? s : answerPending(items, s); }));
  }, [id, itemsOf, items, pending.length, echoesUser]);
  const add = useCallback((sid: string, item: PendingItem) => setPendingBy((b) => addPending(b, sid, item)), []);
  return { items, live, pending, addPending: add, convErr, convKick };
}
