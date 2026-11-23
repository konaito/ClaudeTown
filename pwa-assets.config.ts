// PWA のアイコンを public/app-icon.svg から作る設定。`bun run pwa:icons` で public/pwa/ に書き出す。
// 全面の背景は、アイコンの地の色（#F8E6D0）に合わせる。maskable と apple-touch-icon は、キャラを中央の安全域に収める。
import { defineConfig, type Preset } from "@vite-pwa/assets-generator/config";

const BG = "#F8E6D0";
const preset: Preset = {
  transparent: { sizes: [192, 512], favicons: [], padding: 0 },
  maskable: { sizes: [512], padding: 0.2, resizeOptions: { background: BG, fit: "contain" } },
  apple: { sizes: [180], padding: 0.1, resizeOptions: { background: BG, fit: "contain" } },
  assetName: (type, size) => (type === "transparent" ? `icon-${size.width}.png` : type === "maskable" ? `maskable-${size.width}.png` : `apple-touch-icon-${size.width}.png`),
};
export default defineConfig({ headLinkOptions: { preset: "2023" }, preset, images: ["public/app-icon.svg"] });
