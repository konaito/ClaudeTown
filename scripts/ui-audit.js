// 画面の文字の明暗差と、押せる所の大きさを測る（WCAG 2.2 AA と Apple HIG の macOS の数値）。
// ブラウザ表示（bun run dev）の画面で実行する。agent-browser なら:
//   agent-browser eval "$(cat scripts/ui-audit.js)"
// 返り値は JSON。text は文字の明暗差の不足、target は 24px 未満の押せる所、small は 10px 未満の文字。
// 判定の数値: 文字 4.5:1（大きい文字は 3:1。WCAG の 18pt = 24px、太字 14pt = 18.66px）、押せる所 24×24px（WCAG 2.5.8）、文字 10px 以上（HIG macOS の最小）。
(() => {
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  // 地の色: 自分から上へ background-color を重ねる（画像とグラデーションは見ない）
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of layers.reverse()) bg = over(c, bg);
    return bg;
  };
  // 町は style の zoom で縮める（src/canvas/Stage.tsx）。見えている文字の大きさは祖先の zoom を掛けた値
  const zoomOf = (el) => { let k = 1; for (let e = el; e; e = e.parentElement) k *= parseFloat(getComputedStyle(e).zoom || "1") || 1; return k; };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const disabled = (el) => !!el.closest("button:disabled, [aria-disabled='true'], select:disabled, input:disabled, textarea:disabled");
  const label = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };
  const text = [], small = [], target = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || !visible(el) || el.closest(".xterm, [aria-hidden='true']")) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden") continue;
    const size = Math.round(parseFloat(cs.fontSize) * zoomOf(el) * 10) / 10, bold = Number(cs.fontWeight) >= 700;
    const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = bgOf(el);
    const fg = over({ ...fg0, a: fg0.a * opacityOf(el) }, bg);
    const cr = ratio(fg, bg);
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const key = `${label(el)}|${cs.color}|${Math.round(size * 10)}|${bg.r},${bg.g},${bg.b}`;
    if (cr < need && !disabled(el) && !seen.has(key)) { seen.add(key); text.push({ el: label(el), text: t.slice(0, 24), size, cr: Math.round(cr * 100) / 100, need, color: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` }); }
    if (size < 10 && !seen.has("s" + label(el) + size)) { seen.add("s" + label(el) + size); small.push({ el: label(el), text: t.slice(0, 24), size }); }
  }
  const tseen = new Set();
  for (const el of document.querySelectorAll("button, a[href], select, input, textarea, summary, [role='button'], [role='tab']")) {
    if (!visible(el) || disabled(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) continue;
    // 文の中のリンクは対象外（WCAG 2.5.8 の inline の例外）
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
    const key = `${label(el)}|${Math.round(r.width)}x${Math.round(r.height)}`;
    if (tseen.has(key)) continue; tseen.add(key);
    target.push({ el: label(el), text: (el.textContent || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return JSON.stringify({ text, small, target }, null, 1);
})()
