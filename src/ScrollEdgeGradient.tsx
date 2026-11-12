// スクロールできる方向の端に、淡いブルーグレーから透明へのグラデーションを出す（docs/design/scroll-edge-gradient.md）。
// グラデーションは中身（世帯の枠、カード、会話の吹き出し）の裏、容れ物の地の上に置く。中身はフェードさせず、端の地の色だけが変わる。
// やり方: 外側（wrap）に地の色と、上端・下端に貼り付けたグラデーションの層（position: absolute、z-index 0）を置き、
// その上にスクロールの容れ物（背景は透明、z-index 1）を重ねる。層は容れ物の全幅で、上端と下端にぴったり付く。
// 2026-11-12 までは容れ物の中に sticky の層を置いていたが、容れ物の padding と flex に位置と幅を縛られたのでやめた。
// 上に続きがあれば上端、下に続きがあれば下端に出し、端に着いたらその側を消す。スクロールが要らなければ両方消す。
// 判定は実際のスクロールの容れ物から行い、スクロール、大きさの変更（ResizeObserver）、中身の増減（MutationObserver）に追従する。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";

/** 場所ごとの濃さ。town は世帯の表示領域（続きの方向をはっきり見せる）、soft は会話や欄（控えめ） */
export const SEG_STRENGTH = {
  town: { height: 44, alpha: 0.5 },
  soft: { height: 26, alpha: 0.45 },
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
      <div className={`seg seg-top ${edges.top ? "on" : ""}`} aria-hidden />
      <div className={`seg seg-bottom ${edges.bottom ? "on" : ""}`} aria-hidden />
      <div ref={ref} className={`seg-scroll ${className ?? ""}`} style={style} onClick={onClick}
        onScroll={(e) => { update(); onScroll?.(e); }}>
        {children}
      </div>
    </div>
  );
});
