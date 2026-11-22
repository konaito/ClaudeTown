import { useLayoutEffect, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";

/**
 * 3枚のペイン（#89）の開け閉めの状態。hasSel はセッションを選んでいるか。
 * 右のチャットは、セッションを選んでいないときに閉じ、選んだら開く
 */
export function usePanes(hasSel: boolean, mobile: boolean) {
  const housesRef = usePanelRef();
  const sideRef = usePanelRef();
  const [housesOpen, setHousesOpen] = useState(true);
  const [sideOpen, setSideOpen] = useState(false);
  const selRef = useRef(hasSel);
  selRef.current = hasSel;
  useLayoutEffect(() => {
    const r = sideRef.current;
    if (!r || mobile) return;
    if (hasSel && r.isCollapsed()) r.expand();
    else if (!hasSel && !r.isCollapsed()) r.collapse();
  }, [hasSel, mobile]);
  const toggleHouses = () => { const r = housesRef.current; if (!r) return; if (r.isCollapsed()) r.expand(); else r.collapse(); };
  return { housesRef, sideRef, housesOpen, setHousesOpen, sideOpen, setSideOpen, selRef, toggleHouses };
}
