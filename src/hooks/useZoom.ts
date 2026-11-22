import { useState } from "react";

/** 町の拡大率。"fit" は全体が入る大きさ。0.4 から 1.6 まで 0.1 刻み */
export function useZoom() {
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const zoomOut = () => setZoom((z) => Math.max(0.4, +(((z === "fit" ? 1 : z) - 0.1).toFixed(2))));
  const zoomIn = () => setZoom((z) => Math.min(1.6, +(((z === "fit" ? 1 : z) + 0.1).toFixed(2))));
  const zoomFit = () => setZoom("fit");
  return { zoom, zoomOut, zoomIn, zoomFit };
}
