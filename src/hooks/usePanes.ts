import { useLayoutEffect, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";

/**
 * 3枚のペイン（#89）の開け閉めの状態。hasSel はセッションを選んでいるか。
 * 右のチャットは、セッションを選んでいないときに閉じ、選んだら開く。
 * 窓が3枚の最小幅の和（minAll）より狭いときは、左のペインを閉じてから右を開く。
 * 閉じないと右が幅0のまま開かない（⌘+ で 200% にした 1440px の窓は 720px になる。WCAG 1.4.4）
 */
export function usePanes(hasSel: boolean, mobile: boolean, minAll: number) {
  const housesRef = usePanelRef();
  const sideRef = usePanelRef();
  const [housesOpen, setHousesOpen] = useState(true);
  const [sideOpen, setSideOpen] = useState(false);
  const selRef = useRef(hasSel);
  selRef.current = hasSel;
  useLayoutEffect(() => {
    if (mobile) return;
    const sync = () => {
      const r = sideRef.current;
      if (!r) return;
      if (selRef.current && r.isCollapsed()) {
        const h = housesRef.current;
        if (h && !h.isCollapsed() && window.innerWidth < minAll) h.collapse();
        r.expand();
      } else if (!selRef.current && !r.isCollapsed()) r.collapse();
    };
    sync();
    // 開いたあとで窓を縮めたり拡大したりして、右が押し出されたときも開き直す
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [hasSel, mobile, minAll]);
  const toggleHouses = () => { const r = housesRef.current; if (!r) return; if (r.isCollapsed()) r.expand(); else r.collapse(); };
  return { housesRef, sideRef, housesOpen, setHousesOpen, sideOpen, setSideOpen, selRef, toggleHouses };
}
