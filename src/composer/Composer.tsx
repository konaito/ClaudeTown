// チャットの入力欄。キーの動きは Claude Code の CLI の入力に合わせる。
// 何をどう合わせたか、合わせなかったものと理由は docs/research/cli-input.md の表にある。
import { useLayoutEffect, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import getCaretCoordinates from "textarea-caret";
import type { Agent } from "../model";
import { usePaste, REMOTE_FILES } from "./usePaste";
import { useCompletion } from "./useCompletion";
import { useHistory } from "./useHistory";
import { useHistorySearch } from "./useHistorySearch";
import { routeOf } from "./route";
import { viaCcn, type Support } from "../session/control";
import { canInterrupt as abilityInterrupt, hasTerminal } from "../abilities";
import {
  backslashNewline, histDown, isSlashCommand, histUp, killToEnd, killToStart, killWordBack, killWordForward,
  toLineEnd, toLineStart, wordBack, wordForward, type Edit, type Sel,
} from "./edit";

// セッションごとに持つもの。セッションを切り替えて戻っても残す（CLI の stash と、送った文の履歴）
const stashes = new Map<string, string>();

/** 2回押しの間隔（Esc Esc）。CLI の値は文書に無いので、Ctrl+D の 800ms に合わせた（仮置き） */
const DOUBLE_MS = 800;

const HELP: [string, string][] = [
  ["Enter", "送る（補完が出ているときは選んだコマンドで送る）"],
  ["Shift+Enter・Option+Enter・Ctrl+J・\\ のあと Enter", "改行"],
  ["/", "コマンドとスキル（Tab で決める）"],
  ["@", "ファイル（Tab で決める）"],
  ["!", "シェルモード（端末のあるセッションだけ）"],
  ["↑ ↓・Ctrl+P Ctrl+N", "履歴（先頭か末尾の行にいるとき）"],
  ["Ctrl+R", "履歴を探す（もう一度で古いほうへ）"],
  ["Ctrl+A Ctrl+E", "行の頭・末尾へ"],
  ["Ctrl+K Ctrl+U Ctrl+W", "行末まで・行頭まで・空白まで消す"],
  ["Ctrl+Y・Option+Y", "消した文を貼る・前に消した文に替える"],
  ["Option+B Option+F Option+D", "前の語へ・次の語へ・語の終わりまで消す"],
  ["Ctrl+_", "元に戻す"],
  ["Ctrl+S", "打ちかけを退避する・戻す"],
  ["⌘V（画像）・ファイルを落とす", "画像やファイルのパスを入れる（画像は保存してから）"],
  ["Esc", "作業を止める（作業中）・補完を閉じる"],
  ["Esc Esc", "打ちかけを消して履歴に残す"],
  ["Ctrl+C", "作業を止める（作業中）・打ちかけを消す"],
];

export function Composer({ agent, peer, text, setText, busy, running, support = "no", onSubmit, onError, touch }: {
  /** ノードに command の口があるか（#97）。/ のコマンドの振り分けと、補完の印に使う */
  support?: Support;
  /** スマホ（ソフトキーボード）。Enter は改行にし、送るのは送信ボタンだけにする */
  touch?: boolean;
  agent: Agent; peer: string; text: string; setText: (v: string) => void; busy: boolean; running: boolean;
  onSubmit: (body: string) => Promise<boolean>; onError: (m: string) => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const local = !peer;
  const hasTerm = hasTerminal(agent);
  const canInterrupt = abilityInterrupt(agent);
  const [caret, setCaret] = useState(text.length);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const kills = useRef<string[]>([]);
  const yank = useRef<{ from: number; to: number; i: number } | null>(null);
  const lastEsc = useRef(0);
  const caretAfter = useRef<number | null>(null);
  const { loadHistory, loadAll, remember, histSt, upList, searchList } = useHistory(agent, local);

  // 文をまるごと替えたあと、カーソルを置く
  useLayoutEffect(() => {
    const el = ta.current;
    if (el && caretAfter.current != null) { const p = Math.min(caretAfter.current, el.value.length); el.setSelectionRange(p, p); setCaret(p); caretAfter.current = null; }
  });
  const replaceAll = (t: string, at = t.length) => { caretAfter.current = at; setText(t); };

  const submit = async (body: string) => {
    if (!body.trim() || busy || !agent.canSend) return;
    const ok = await onSubmit(body);
    if (ok) { remember(body); histSt.current = { index: -1, draft: "" }; setHelp(false); setTimeout(loadHistory, 1500); }
  };

  const { search, startSearch, searchMatch, runSearch, endSearch, onSearchKey } = useHistorySearch({ searchList, text, ta, replaceAll, submit, loadAll });

  // ccn を通さないセッション（#96）は、コマンドの振り分けでは端末のセッションと同じに扱う
  const ccnKind = viaCcn(agent) ? agent.kind : "terminal";
  const { token, slashItems, tags, files, menu, menuOpen, pick, setPick, menuRef, accept } = useCompletion({ agent, local, text, caret, search, dismissed, ccnKind, support, replaceAll });

  const sel = (): Sel => { const el = ta.current!; return { text: el.value, start: el.selectionStart, end: el.selectionEnd }; };
  /** 範囲を置き換える。execCommand を使い、⌘Z で戻せるようにする */
  const apply = (e: Edit) => {
    const el = ta.current!;
    el.focus();
    el.setSelectionRange(e.from, e.to);
    const want = el.value.slice(0, e.from) + e.insert + el.value.slice(e.to);
    const ok = e.insert ? document.execCommand("insertText", false, e.insert) : e.from === e.to || document.execCommand("delete");
    // 窓が前面にないとき（Finder から落としたとき）は、execCommand が true を返しても文が入らないことがある
    if (!ok || el.value !== want) replaceAll(want, e.from + e.insert.length);
    if (e.killed) { kills.current = [e.killed, ...kills.current.filter((k) => k !== e.killed)].slice(0, 20); }
  };
  const moveTo = (p: number) => { ta.current!.setSelectionRange(p, p); setCaret(p); };

  const [stopping, setStopping] = useState(false);
  const interrupt = () => invoke("interrupt_session", { sessionId: agent.id, peer: peer || null }).catch((e) => onError(`止められなかった: ${e}`));
  const clearDraft = () => { if (text.trim()) remember(text); histSt.current = { index: -1, draft: "" }; replaceAll(""); };

  // onKeyDown の分岐。true を返したら、そのキーは処理済みで、あとの分岐へ進まない
  type Key = { e: React.KeyboardEvent<HTMLTextAreaElement>; k: string; ctrl: boolean; alt: boolean; plain: boolean; stop: () => void };

  /** 補完が出ているとき */
  const menuKey = ({ k, ctrl, plain, stop }: Key): boolean => {
    if (!menuOpen) return false;
    if ((plain && k === "ArrowDown") || (ctrl && k === "n")) { stop(); setPick((p) => (p + 1) % menu.length); return true; }
    if ((plain && k === "ArrowUp") || (ctrl && k === "p")) { stop(); setPick((p) => (p - 1 + menu.length) % menu.length); return true; }
    if (plain && k === "Tab") { stop(); accept(); return true; }
    if (plain && k === "Escape") { stop(); setDismissed(text); return true; }
    // / の補完で Enter を押すと、選んだコマンドで送る。@ の補完では打った文のまま送る（2026-11-13 に CLI で実測）
    if (plain && k === "Enter" && token?.kind === "slash") { stop(); const next = accept(); if (next) submit(next.trimEnd()); return true; }
    return false;
  };

  /** 送ると改行 */
  const sendKey = ({ e, k, ctrl, alt, plain, stop }: Key): boolean => {
    if (k === "Enter") {
      if (touch) return true;
      if (e.shiftKey || alt || (e.altKey && !e.metaKey)) { stop(); apply({ ...selRange(), insert: "\n" }); return true; }
      if (plain) {
        stop();
        const bs = backslashNewline(sel());
        if (bs) { apply(bs); return true; }
        submit(text);
        return true;
      }
      if (e.metaKey || e.ctrlKey) { stop(); submit(text); return true; }
    }
    if (ctrl && k === "j") { stop(); apply({ ...selRange(), insert: "\n" }); return true; }
    return false;
  };

  /** 履歴を辿る・検索を始める */
  const historyKey = ({ k, ctrl, plain, stop }: Key): boolean => {
    if ((plain && k === "ArrowUp") || (ctrl && k === "p")) {
      if (!onFirstRow()) return true;
      const r = histUp(histSt.current, upList, text);
      if (!r) return true;
      stop(); histSt.current = r.st; setDismissed(r.text); replaceAll(r.text); return true;
    }
    if ((plain && k === "ArrowDown") || (ctrl && k === "n")) {
      if (!onLastRow()) return true;
      const r = histDown(histSt.current, upList);
      if (!r) return true;
      stop(); histSt.current = r.st; setDismissed(r.text); replaceAll(r.text); return true;
    }
    if (ctrl && k === "r") { stop(); startSearch(); return true; }
    return false;
  };

  /** readline の編集 */
  const editKey = ({ e, k, ctrl, alt, stop }: Key): boolean => {
    if (ctrl && k === "a") { stop(); moveTo(toLineStart(sel())); return true; }
    if (ctrl && k === "e") { stop(); moveTo(toLineEnd(sel())); return true; }
    if (ctrl && k === "k") { stop(); const ed = killToEnd(sel()); if (ed) apply(ed); return true; }
    if (ctrl && k === "u") { stop(); const ed = killToStart(sel()); if (ed) apply(ed); return true; }
    if (ctrl && k === "w") { stop(); const ed = killWordBack(sel()); if (ed) apply(ed); return true; }
    if (ctrl && k === "y") {
      stop();
      const t = kills.current[0];
      if (!t) return true;
      const s = sel();
      apply({ from: s.start, to: s.end, insert: t });
      yank.current = { from: s.start, to: s.start + t.length, i: 0 };
      return true;
    }
    if (alt && e.code === "KeyY") {
      stop();
      const y = yank.current;
      if (!y || kills.current.length < 2) return true;
      const i = (y.i + 1) % kills.current.length;
      const t = kills.current[i];
      apply({ from: y.from, to: y.to, insert: t });
      yank.current = { from: y.from, to: y.from + t.length, i };
      return true;
    }
    // Option の文字（∫ など）が入らないよう、e.code で見る
    if (alt && e.code === "KeyB") { stop(); moveTo(wordBack(sel())); return true; }
    if (alt && e.code === "KeyF") { stop(); moveTo(wordForward(sel())); return true; }
    if (alt && e.code === "KeyD") { stop(); const ed = killWordForward(sel()); if (ed) apply(ed); return true; }
    if (e.ctrlKey && !e.metaKey && (k === "_" || (e.shiftKey && k === "-"))) { stop(); document.execCommand("undo"); return true; }
    return false;
  };

  /** 打ちかけの退避 */
  const stashKey = ({ k, ctrl, stop }: Key): boolean => {
    if (!(ctrl && k === "s")) return false;
    stop();
    const st = stashes.get(agent.id);
    if (text) { stashes.set(agent.id, text); replaceAll(""); }
    else if (st != null) { stashes.delete(agent.id); replaceAll(st); }
    return true;
  };

  /** 止める・消す・キーの一覧 */
  const stopKey = ({ e, k, ctrl, plain, stop }: Key): boolean => {
    if (ctrl && k === "c") {
      if (ta.current && ta.current.selectionStart !== ta.current.selectionEnd && !running) return true;
      stop();
      if (running && canInterrupt) { interrupt(); return true; }
      if (text) clearDraft();
      return true;
    }
    if (plain && k === "Escape") {
      stop();
      if (help) { setHelp(false); return true; }
      if (running && canInterrupt) { interrupt(); return true; }
      const now = Date.now();
      if (text && now - lastEsc.current < DOUBLE_MS) { lastEsc.current = 0; clearDraft(); return true; }
      lastEsc.current = now;
      return true;
    }
    // 空のときの ? はキーの一覧
    if (k === "?" && !text && !e.ctrlKey && !e.metaKey) { stop(); setHelp((h) => !h); return true; }
    return false;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語の変換中は何もしない（変換を決める Enter で送らない）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const k = e.key;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const alt = e.altKey && !e.ctrlKey && !e.metaKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const key: Key = { e, k, ctrl, alt, plain, stop: () => e.preventDefault() };
    if (k !== "Escape") lastEsc.current = 0;
    if (!(ctrl && k === "y") && !(alt && e.code === "KeyY")) yank.current = null;
    // この順に試す。順序は元の if の並びと同じ
    menuKey(key) || sendKey(key) || historyKey(key) || editKey(key) || stashKey(key) || stopKey(key);
  };

  const selRange = () => { const s = sel(); return { from: s.start, to: s.end }; };
  // 上下キーで履歴へ移るのは、カーソルが先頭か末尾の表示行にいるとき（折り返しも1行と数える）
  const onFirstRow = () => {
    const el = ta.current!;
    if (!el.value || el.selectionStart === 0) return true;
    return getCaretCoordinates(el, el.selectionStart).top <= getCaretCoordinates(el, 0).top + 1;
  };
  const onLastRow = () => {
    const el = ta.current!;
    if (!el.value || el.selectionEnd === el.value.length) return true;
    return getCaretCoordinates(el, el.selectionEnd).top >= getCaretCoordinates(el, el.value.length).top - 1;
  };

  const { dropping, onPaste } = usePaste({ ta, local, canSend: agent.canSend, searching: !!search, sel, apply, onError });

  const shell = text.startsWith("!");
  const cmdAtStart = isSlashCommand(text);
  // 組み込みのコマンドの振り分け（#97）。送る前に、どうなるかを入力欄の下に出す
  const route = cmdAtStart ? routeOf(text, ccnKind, support) : null;
  const note = route?.kind === "blocked" ? route.reason
    : route?.kind === "command" ? `Enter でコマンドとして実行する${route.note ? `（${route.note}）` : ""}`
    : (shell || cmdAtStart) && !hasTerm
    ? "端末の無いセッション（-p の子）なので、CLI のコマンドとしては動かず、Claude が文として読む"
    : shell ? "! シェルモード: 端末のセッションで、そのまま実行する"
    : search ? "Ctrl+R で古いほうへ・Enter で送る・Tab か Esc で直す・Ctrl+C でやめる"
    : "Enter で送信・Shift+Enter で改行・/ でコマンド・@ でファイル・? でキーの一覧";

  return (
    <>
      <div className={`box${shell ? " shell" : ""}${dropping ? " dropping" : ""}`}>
        {dropping && (
          <div className={`cmp-drop${local && agent.canSend ? "" : " no"}`}>
            {!agent.canSend ? "このセッションには送れない" : local ? "離すとファイルのパスを入れる" : REMOTE_FILES}
          </div>
        )}
        {menuOpen && (
          <div className="cmp-menu" ref={menuRef} role="listbox">
            {token?.kind === "slash"
              ? slashItems.map((c, i) => (
                <button key={c.source + c.name} className={i === pick ? "on" : ""} role="option" aria-selected={i === pick}
                  onMouseDown={(e) => { e.preventDefault(); setPick(i); accept(i); }}>
                  <span className={`cm-name${tags[i]?.off ? " off" : ""}`}>/{c.name}{c.argumentHint ? <em> {c.argumentHint}</em> : null}</span>
                  <span className="cm-desc">{c.description}{c.source !== "builtin" ? ` (${c.source})` : ""}</span>
                  {tags[i] && <span className={`cm-tag${tags[i]!.off ? " off" : ""}`} title={tags[i]!.title}>{tags[i]!.text}</span>}
                </button>
              ))
              : files.map((f, i) => (
                <button key={f} className={i === pick ? "on" : ""} role="option" aria-selected={i === pick}
                  onMouseDown={(e) => { e.preventDefault(); setPick(i); accept(i); }}>
                  <span className="cm-name">{f.endsWith("/") ? "+ " : ""}{f}</span>
                </button>
              ))}
          </div>
        )}
        {help && (
          <div className="cmp-help">
            {HELP.map(([key, what]) => <div key={key}><kbd>{key}</kbd><span>{what}</span></div>)}
          </div>
        )}
        {search && (
          <div className="cmp-search">
            <span>履歴を検索:</span>
            <input autoFocus value={search.query} onKeyDown={onSearchKey}
              onChange={(e) => { const q = e.target.value; runSearch(q, 0); }}
              onBlur={() => { if (search) endSearch(true); }} />
            {search.query && searchMatch == null && <em>見つからない</em>}
          </div>
        )}
        {/* CLI の端末と同じく、macOS の予測入力、自動修正、スペルチェックを切る。予測が出ていると、上キーが予測を閉じるのに使われ、行も履歴も動かない（2026-11-13 に開発版で見た） */}
        <textarea
          ref={ta}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          {...{ writingsuggestions: "false" }}
          value={search ? searchMatch ?? search.original : text}
          readOnly={!!search}
          placeholder={agent.canSend ? `${agent.name}に注文する…` : "このセッションには送れない"}
          disabled={!agent.canSend}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setDismissed(null); histSt.current = { index: -1, draft: "" }; }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {/* 作業中で入力が空なら、送るボタンを止めるボタンにする。Esc と Ctrl+C を押せないスマホでも止められる（#83）。
            文を打てば送るボタンに戻り、送った文は今の作業のあとに読まれる */}
        {running && canInterrupt && !text.trim() && !search ? (
          <button className="send stop" disabled={stopping} onClick={() => { setStopping(true); interrupt().finally(() => setStopping(false)); }} title="今の作業を止める（Esc）" aria-label="止める">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><rect x="1" y="1" width="12" height="12" rx="2.5" fill="currentColor" /></svg>
          </button>
        ) : (
          <button className="send" disabled={!agent.canSend || busy || !text.trim()} onClick={() => submit(text)} title="送る（Enter）">
            <SendIcon />
          </button>
        )}
      </div>
      <div className={`hint${route?.kind === "blocked" ? " bad" : ""}`}>{note}</div>
    </>
  );
}

function SendIcon() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 11.5 20.5 4l-5 17-3.6-7.2z" /><path d="M11.9 13.8 20.5 4" stroke="#fff" strokeWidth="1.4" /></svg>);
}
