// スクロールできる方向の端に、淡いブルーグレーから透明へのグラデーションを重ねる（docs/design/scroll-edge-gradient.md）。
// グラデーションはスクロールの容れ物の上端と下端に固定し、中身と一緒には動かない。操作は妨げない（pointer-events: none）。
// 上に続きがあれば上端、下に続きがあれば下端に出し、端に着いたらその側を消す。スクロールが要らなければ両方消す。
// 判定は実際のスクロールの容れ物から行い、スクロール、大きさの変更（ResizeObserver）、中身の増減（MutationObserver）に追従する。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";

/** 場所ごとの濃さ。town は世帯の表示領域（続きの方向をはっきり見せる）、soft は会話や欄（控えめ） */
export const SEG_STRENGTH = {
  town: { height: 46, alpha: 0.95 },
  soft: { height: 16, alpha: 0.35 },
} as const;

type Props = {
  /** スクロールの容れ物（中側）に付けるクラス。overflow: auto はこちらに書く */
  className?: string;
  style?: CSSProperties;
  /** 外側（グラデーションの基準）に付けるクラス。flex の伸び縮みはこちらに書く */
  wrapClassName?: string;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** 濃さ（SEG_STRENGTH のキー）。省くと soft */
  strength?: keyof typeof SEG_STRENGTH;
  children: ReactNode;
};

export const ScrollEdgeGradient = forwardRef<HTMLDivElement, Props>(function ScrollEdgeGradient(
  { className, style, wrapClassName, onScroll, onClick, strength = "soft", children }, outerRef,
) {
  const ref = useRef<HTMLDivElement>(null);
  useImperativeHandle(outerRef, () => ref.current!, []);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    const mo = new MutationObserver(() => {
      // 子が増えたら、その大きさの変化も見る
      for (const c of Array.from(el.children)) ro.observe(c);
      update();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [update]);

  return (
    <div className={`seg-wrap ${wrapClassName ?? ""}`}
      style={{ ["--seg-h" as string]: `${SEG_STRENGTH[strength].height}px`, ["--seg-a" as string]: SEG_STRENGTH[strength].alpha } as CSSProperties}>
      <div ref={ref} className={className} style={style} onClick={onClick}
        onScroll={(e) => { update(); onScroll?.(e); }}>
        {children}
      </div>
      <div className={`seg seg-top ${edges.top ? "on" : ""}`} aria-hidden />
      <div className={`seg seg-bottom ${edges.bottom ? "on" : ""}`} aria-hidden />
    </div>
  );
});
