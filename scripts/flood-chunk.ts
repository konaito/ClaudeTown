// claude の出力中に近い書き換えを1かたまりずつ作る（#8、#9）。mock-ccn-flood.ts と mock-ccn-town.ts が使う。
// 毎回スピナーの行と入力欄の枠（5行）を描き直し、10回に1回は文を1行足す
const enc = new TextEncoder();
const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function floodChunks(hz: number, cols: () => number) {
  let tick = 0;
  return (): Uint8Array => {
    tick++;
    const w = Math.max(20, cols() - 2);
    let s = "\x1b[?2026h";
    if (tick % 10 === 0) s += `\x1b[6A\x1b[2K● 行 ${tick / 10}: ${"lorem ipsum dolor sit amet ".repeat(4).slice(0, w - 12)}\r\n\r\n\r\n\r\n\r\n\r\n`;
    s += `\x1b[6A\r\x1b[2K\x1b[38;5;208m${spin[tick % spin.length]}\x1b[0m Working… (${(tick / hz).toFixed(1)}s · ↓ ${tick * 3} tokens)\r\n`;
    s += `\x1b[2K╭${"─".repeat(w)}╮\r\n\x1b[2K│ ❯ ${" ".repeat(w - 3)}│\r\n\x1b[2K╰${"─".repeat(w)}╯\r\n\x1b[2K  ? for shortcuts\r\n\x1b[2K`;
    s += "\x1b[?2026l";
    return enc.encode(s);
  };
}
