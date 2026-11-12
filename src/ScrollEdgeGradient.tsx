// スクロールできる方向の端に、淡いブルーグレーから透明へのグラデーションを出す（docs/design/scroll-edge-gradient.md）。
// グラデーションは中身（世帯の枠、カード、会話の吹き出し）の裏、容れ物の地の上に置く。中身はフェードさせず、端の地の色だけが変わる。
// やり方: 外側（wrap）に地の色と、上端・下端に貼り付けたグラデーションの層（position: absolute、z-index 0）を置き、
// その上にスクロールの容れ物（背景は透明、z-index 1）を重ねる。層は容れ物の全幅で、上端と下端にぴったり付く。
// 2026-11-12 までは容れ物の中に sticky の層を置いていたが、容れ物の padding と flex に位置と幅を縛られたのでやめた。
// 濃さは端までの残り距離に比例させる: 不透明度 = min(1, 残り距離 / しきい値)。しきい値はグラデーションの高さの FADE_RATIO 倍。
// 端に近づくと連続して薄くなり、着いたときにちょうど 0 になる。スクロールが要らなければ両方 0。
// 2026-11-12 までは端に着いた瞬間に表示を切り替えていた（0.18 秒のフェードでも切り替わりが見えたのでやめた）。
// 実装は CSS のスクロール連動アニメーション。容れ物に scroll-timeline、外側に timeline-scope を付け、兄弟の層が同じ名前の
// タイムラインを animation-range（px）で読む。中身の増減や窓の大きさの変更もブラウザが同じ式で追従するので JS は要らない。
// WKWebView（Tauri の macOS）で、残り 38px で 0.4935（= 38 / 77）、着いて 0、スクロールが要らないとき 0 になることを実測した。
import { forwardRef, useId, type CSSProperties, type ReactNode, type UIEvent } from "react";

/** 場所ごとの濃さ。town は世帯の表示領域（続きの方向をはっきり見せる）、soft は会話や欄（控えめ） */
export const SEG_STRENGTH = {
  town: { height: 44, alpha: 0.5 },
  soft: { height: 26, alpha: 0.45 },
} as const;

/** しきい値（グラデーションの高さの何倍の距離で濃さが 0 から 1 になるか） */
export const FADE_RATIO = 1.75;

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
  { className, style, wrapClassName, onScroll, onClick, strength = "soft", children }, ref,
) {
  // タイムラインの名前は個体ごとに分ける（入れ子や並びの容れ物と混ざらないように）
  const tl = `--seg-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <div className={`seg-wrap ${wrapClassName ?? ""}`}
      style={{
        ["--seg-h" as string]: `${SEG_STRENGTH[strength].height}px`,
        ["--seg-a" as string]: SEG_STRENGTH[strength].alpha,
        ["--seg-r" as string]: FADE_RATIO,
        ["--seg-tl" as string]: tl,
        timelineScope: tl,
      } as CSSProperties}>
      <div className="seg seg-top" style={{ animationTimeline: tl } as CSSProperties} aria-hidden />
      <div className="seg seg-bottom" style={{ animationTimeline: tl } as CSSProperties} aria-hidden />
      <div ref={ref} className={`seg-scroll ${className ?? ""}`} style={{ ...style, scrollTimeline: `${tl} block` } as CSSProperties} onClick={onClick}
        onScroll={onScroll}>
        {children}
      </div>
    </div>
  );
});
