// 返事の文を出す小さい Markdown 表示。段落、見出し、箇条書き、太字、インラインのコードだけを扱う。
// 「できたこと」「やったこと」などの見出しの下の箇条書きと、✓ で始まる行は、チェックの付いた一覧にする。
// HTML は解釈しない（文字列のまま出す）。
import { memo, type ReactNode } from "react";
import { chatPerf } from "./chatPerf";

const DONE_HEAD = /(できたこと|やったこと|終わったこと|完了|直したこと|分かったこと|確認済み)/;
const CHECK = /^(✓|✅|☑|\[x\])\s*/i;

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith("**") ? <b key={m.index}>{t.slice(2, -2)}</b> : <code key={m.index}>{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

type Block = { kind: "p" | "h" | "ul" | "ol" | "code"; lines: string[]; check?: boolean };

function blocks(text: string): Block[] {
  chatPerf.md++;
  const out: Block[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let inCode = false;
  let prevHead = "";
  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      if (inCode) { inCode = false; continue; }
      inCode = true; out.push({ kind: "code", lines: [] }); continue;
    }
    if (inCode) { out[out.length - 1].lines.push(raw); continue; }
    const line = raw.trimEnd();
    if (!line.trim()) { prevHead = out[out.length - 1]?.kind === "h" ? prevHead : ""; out.push({ kind: "p", lines: [] }); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/) ?? line.match(/^\*\*(.+)\*\*[:：]?$/);
    if (h) { out.push({ kind: "h", lines: [h[1]] }); prevHead = h[1]; continue; }
    const ul = line.match(/^\s*[-*・]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)．]\s+(.*)$/);
    const item = ul?.[1] ?? ol?.[1];
    if (item !== undefined) {
      const kind = ul ? "ul" : "ol";
      const cur = out[out.length - 1];
      if (cur && cur.kind === kind) cur.lines.push(item);
      else out.push({ kind, lines: [item], check: kind === "ul" && DONE_HEAD.test(prevHead) });
      if (CHECK.test(item)) out[out.length - 1].check = true;
      continue;
    }
    // 「できたこと:」のような1行の見出し
    if (/[:：]$/.test(line) && line.length <= 20) { out.push({ kind: "h", lines: [line.replace(/[:：]$/, "")] }); prevHead = line; continue; }
    const cur = out[out.length - 1];
    if (cur && cur.kind === "p" && cur.lines.length) cur.lines.push(line);
    else out.push({ kind: "p", lines: [line] });
  }
  return out.filter((b) => b.lines.length);
}

/** 同じ文は解析し直さない（#10）。吹き出しが描き直されても、文が同じなら前の結果を使う */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const bs = blocks(text);
  return (
    <div className="md">
      {bs.map((b, i) => {
        switch (b.kind) {
          case "h": return <div key={i} className="md-h">{inline(b.lines[0])}</div>;
          case "code": return <pre key={i}>{b.lines.join("\n")}</pre>;
          case "ul":
          case "ol": {
            const Tag = b.kind;
            return (
              <Tag key={i} className={b.check ? "md-check" : ""}>
                {b.lines.map((l, j) => <li key={j}>{inline(l.replace(CHECK, ""))}</li>)}
              </Tag>
            );
          }
          default: return <p key={i}>{b.lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l)}</span>)}</p>;
        }
      })}
    </div>
  );
});
