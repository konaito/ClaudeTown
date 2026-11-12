// 返事の文を出す小さい Markdown 表示。段落、見出し、箇条書き、太字、インラインのコード、リンクだけを扱う。
// http と https の URL と [文字](URL) はリンクにし、押すと既定のブラウザで開く（src/links.ts）。
// 「できたこと」「やったこと」などの見出しの下の箇条書きと、✓ で始まる行は、チェックの付いた一覧にする。
// HTML は解釈しない（文字列のまま出す）。
import { memo, type MouseEvent, type ReactNode } from "react";
import { chatPerf } from "./chatPerf";
import { openExternal, safeUrl, splitLinks } from "./links";

const DONE_HEAD = /(できたこと|やったこと|終わったこと|完了|直したこと|分かったこと|確認済み)/;
const CHECK = /^(✓|✅|☑|\[x\])\s*/i;

/** 押すと既定のブラウザで開くリンク。アプリの画面は移らない */
export function ExtLink({ url, children }: { url: string; children: ReactNode }) {
  const open = (e: MouseEvent) => {
    // 既定の動き（WebView の遷移）は必ず止める。親のボタンなどにも押したことを伝えない
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 0) openExternal(url);
  };
  return <a className="ext-link" href={url} title={url} onClick={open} onAuxClick={open} draggable={false}>{children}</a>;
}

/** 文の中の URL をリンクにする */
export function linkify(s: string, key: string | number = 0): ReactNode[] {
  return splitLinks(s).map((p, i) => (p.url ? <ExtLink key={`${key}-${i}`} url={p.url}>{p.text}</ExtLink> : p.text));
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 太字、コード、[文字](URL) を先に切り出し、残りの文の中で URL を探す（URL が ** や ` を巻き込まないように）
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...linkify(s.slice(last, m.index), `t${last}`));
    const t = m[0];
    const k = m.index;
    if (t.startsWith("**")) out.push(<b key={k}>{linkify(t.slice(2, -2), k)}</b>);
    else if (t.startsWith("`")) out.push(<code key={k}>{linkify(t.slice(1, -1), k)}</code>);
    else {
      const [, label, href] = t.match(/^\[(.+)\]\((.+)\)$/)!;
      const url = safeUrl(href);
      out.push(url ? <ExtLink key={k} url={url}>{label}</ExtLink> : t);
    }
    last = m.index + t.length;
  }
  if (last < s.length) out.push(...linkify(s.slice(last), `t${last}`));
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
          case "code": return <pre key={i}>{linkify(b.lines.join("\n"), i)}</pre>;
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
