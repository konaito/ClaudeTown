// チャットの入力欄。キーの動きは Claude Code の CLI の入力に合わせる。
// 何をどう合わせたか、合わせなかったものと理由は docs/research/cli-input.md の表にある。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { call as invoke, onFileDrop } from "../bridge";
import getCaretCoordinates from "textarea-caret";
import type { Agent } from "../model";
import { BUILTINS, type Command } from "./commands";
import {
  backslashNewline, histDown, insertPaths, histUp, killToEnd, killToStart, killWordBack, killWordForward, mergeHistory, pushHistory,
  rankCommands, searchHistory, tokenAt, toLineEnd, toLineStart, wordBack, wordForward, type Edit, type HistState, type Sel,
} from "./edit";

type History = { project: string[]; all: string[] };

// セッションごとに持つもの。セッションを切り替えて戻っても残す（CLI の stash と、送った文の履歴）
const stashes = new Map<string, string>();
const sentBy = new Map<string, string[]>();
// スキルの一覧は作業フォルダごとに1回だけ読む
const skillsByCwd = new Map<string, Command[]>();

/** 2回押しの間隔（Esc Esc）。CLI の値は文書に無いので、Ctrl+D の 800ms に合わせた（仮置き） */
const DOUBLE_MS = 800;

/** 別の機械のセッションには手元のパスが届かないので、画像とファイルは断る */
const REMOTE_FILES = "別の機械のセッションには画像やファイルを渡せない（手元のパスは届かない）";

type Pasted = { files: string[]; image: string | null };

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

export function Composer({ agent, peer, text, setText, busy, running, onSubmit, onError }: {
  agent: Agent; peer: string; text: string; setText: (v: string) => void; busy: boolean; running: boolean;
  onSubmit: (body: string) => Promise<boolean>; onError: (m: string) => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const local = !peer;
  const hasTerm = !!agent.capabilities?.terminal;
  const canInterrupt = !!agent.capabilities?.interrupt;
  const [caret, setCaret] = useState(text.length);
  const [hist, setHist] = useState<History>({ project: [], all: [] });
  const [skills, setSkills] = useState<Command[]>(() => skillsByCwd.get(agent.cwd) ?? []);
  const [files, setFiles] = useState<string[]>([]);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [search, setSearch] = useState<{ query: string; idx: number; original: string } | null>(null);
  const histSt = useRef<HistState>({ index: -1, draft: "" });
  // 検索を閉じたあと、検索欄の blur でもう一度閉じない（Ctrl+C でやめたのに、一致した文で上書きしないように）
  const searchEnding = useRef(false);
  const kills = useRef<string[]>([]);
  const yank = useRef<{ from: number; to: number; i: number } | null>(null);
  const lastEsc = useRef(0);
  const caretAfter = useRef<number | null>(null);
  const [sent, setSent] = useState<string[]>(() => sentBy.get(agent.id) ?? []);
  const [dropping, setDropping] = useState(false);
  // 貼り付けとドロップの返事が来る前に、別のセッションへ替わって入力欄が消えていることがある
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // 履歴は CLI と同じ ~/.claude/history.jsonl から読む（手元のセッションだけ）。上下キーの分（同じ project）は開いたときと送るたびに読む。
  // Ctrl+R の分（全部の project、1000件で約1.2MB）は、Ctrl+R を押したときだけ読む
  const loadHistory = () => {
    if (!local) return;
    invoke<History>("prompt_history", { cwd: agent.cwd || null, all: false }).then((h) => { if (Array.isArray(h?.project)) setHist((x) => ({ ...x, project: h.project })); }).catch(() => {});
  };
  const loadAll = () => {
    if (!local) return;
    invoke<History>("prompt_history", { cwd: agent.cwd || null, all: true }).then((h) => { if (Array.isArray(h?.all)) setHist((x) => ({ ...x, all: h.all })); }).catch(() => {});
  };
  useEffect(loadHistory, [agent.id, agent.cwd, local]);
  useEffect(() => {
    if (!local || !agent.cwd || skillsByCwd.has(agent.cwd)) return;
    invoke<Command[]>("slash_commands", { cwd: agent.cwd }).then((l) => { if (!Array.isArray(l)) return; skillsByCwd.set(agent.cwd, l); setSkills(l); }).catch(() => {});
  }, [agent.cwd, local]);

  const upList = useMemo(() => mergeHistory(sent, hist.project), [sent, hist.project]);
  const searchList = useMemo(() => mergeHistory(sent, hist.all), [sent, hist.all]);
  const remember = (t: string) => { const n = pushHistory(sentBy.get(agent.id) ?? [], t); sentBy.set(agent.id, n); setSent(n); };

  // 補完
  const token = search ? null : tokenAt({ text, start: caret, end: caret });
  const commands = useMemo(() => [...BUILTINS, ...skills], [skills]);
  const slashItems = token?.kind === "slash" ? rankCommands(commands, token.query) : [];
  useEffect(() => {
    if (token?.kind !== "file" || !local || !agent.cwd) { setFiles([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      invoke<string[]>("file_suggestions", { cwd: agent.cwd, query: token.query }).then((l) => { if (alive && Array.isArray(l)) setFiles(l); }).catch(() => {});
    }, 60);
    return () => { alive = false; clearTimeout(t); };
  }, [token?.kind, token?.query, agent.cwd, local]);
  const menu = dismissed === text ? [] : token?.kind === "slash" ? slashItems : token?.kind === "file" ? files : [];
  const menuOpen = menu.length > 0;
  useEffect(() => { setPick(0); }, [token?.kind, token?.query]);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { menuRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }, [pick]);

  // 文をまるごと替えたあと、カーソルを置く
  useLayoutEffect(() => {
    const el = ta.current;
    if (el && caretAfter.current != null) { const p = Math.min(caretAfter.current, el.value.length); el.setSelectionRange(p, p); setCaret(p); caretAfter.current = null; }
  });
  const replaceAll = (t: string, at = t.length) => { caretAfter.current = at; setText(t); };

  const sel = (): Sel => { const el = ta.current!; return { text: el.value, start: el.selectionStart, end: el.selectionEnd }; };
  /** 範囲を置き換える。execCommand を使い、⌘Z で戻せるようにする */
  const apply = (e: Edit) => {
    const el = ta.current!;
    el.focus();
    el.setSelectionRange(e.from, e.to);
    const ok = e.insert ? document.execCommand("insertText", false, e.insert) : e.from === e.to || document.execCommand("delete");
    if (!ok) replaceAll(el.value.slice(0, e.from) + e.insert + el.value.slice(e.to), e.from + e.insert.length);
    if (e.killed) { kills.current = [e.killed, ...kills.current.filter((k) => k !== e.killed)].slice(0, 20); }
  };
  const moveTo = (p: number) => { ta.current!.setSelectionRange(p, p); setCaret(p); };

  const accept = (i = pick) => {
    if (!token) return "";
    if (token.kind === "slash") {
      const c = slashItems[i];
      if (!c) return "";
      const next = `${text.slice(0, token.from)}/${c.name} ${text.slice(token.to).replace(/^[ \t]+/, "")}`;
      replaceAll(next, token.from + c.name.length + 2);
      return next;
    }
    const f = files[i];
    if (!f) return "";
    // フォルダは続けて中を選べるように空白を付けない
    const add = f.endsWith("/") ? f : `${f} `;
    const next = `${text.slice(0, token.from)}@${add}${text.slice(token.to).replace(/^[ \t]+/, "")}`;
    replaceAll(next, token.from + 1 + add.length);
    return next;
  };

  const submit = async (body: string) => {
    if (!body.trim() || busy || !agent.canSend) return;
    const ok = await onSubmit(body);
    if (ok) { remember(body); histSt.current = { index: -1, draft: "" }; setHelp(false); setTimeout(loadHistory, 1500); }
  };

  const interrupt = () => invoke("interrupt_session", { sessionId: agent.id, peer: peer || null }).catch((e) => onError(`止められなかった: ${e}`));
  const clearDraft = () => { if (text.trim()) remember(text); histSt.current = { index: -1, draft: "" }; replaceAll(""); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 日本語の変換中は何もしない（変換を決める Enter で送らない）
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const k = e.key;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const alt = e.altKey && !e.ctrlKey && !e.metaKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const stop = () => e.preventDefault();
    if (k !== "Escape") lastEsc.current = 0;
    if (!(ctrl && k === "y") && !(alt && e.code === "KeyY")) yank.current = null;

    // 補完が出ているとき
    if (menuOpen) {
      if ((plain && k === "ArrowDown") || (ctrl && k === "n")) { stop(); setPick((p) => (p + 1) % menu.length); return; }
      if ((plain && k === "ArrowUp") || (ctrl && k === "p")) { stop(); setPick((p) => (p - 1 + menu.length) % menu.length); return; }
      if (plain && k === "Tab") { stop(); accept(); return; }
      if (plain && k === "Escape") { stop(); setDismissed(text); return; }
      // / の補完で Enter を押すと、選んだコマンドで送る。@ の補完では打った文のまま送る（2026-11-13 に CLI で実測）
      if (plain && k === "Enter" && token?.kind === "slash") { stop(); const next = accept(); if (next) submit(next.trimEnd()); return; }
    }

    // 送ると改行
    if (k === "Enter") {
      if (e.shiftKey || alt || (e.altKey && !e.metaKey)) { stop(); apply({ ...selRange(), insert: "\n" }); return; }
      if (plain) {
        stop();
        const bs = backslashNewline(sel());
        if (bs) { apply(bs); return; }
        submit(text);
        return;
      }
      if (e.metaKey || e.ctrlKey) { stop(); submit(text); return; }
    }
    if (ctrl && k === "j") { stop(); apply({ ...selRange(), insert: "\n" }); return; }

    // 履歴
    if ((plain && k === "ArrowUp") || (ctrl && k === "p")) {
      if (!onFirstRow()) return;
      const r = histUp(histSt.current, upList, text);
      if (!r) return;
      stop(); histSt.current = r.st; setDismissed(r.text); replaceAll(r.text); return;
    }
    if ((plain && k === "ArrowDown") || (ctrl && k === "n")) {
      if (!onLastRow()) return;
      const r = histDown(histSt.current, upList);
      if (!r) return;
      stop(); histSt.current = r.st; setDismissed(r.text); replaceAll(r.text); return;
    }
    if (ctrl && k === "r") { stop(); loadAll(); searchEnding.current = false; setSearch({ query: "", idx: -1, original: text }); return; }

    // readline の編集
    if (ctrl && k === "a") { stop(); moveTo(toLineStart(sel())); return; }
    if (ctrl && k === "e") { stop(); moveTo(toLineEnd(sel())); return; }
    if (ctrl && k === "k") { stop(); const ed = killToEnd(sel()); if (ed) apply(ed); return; }
    if (ctrl && k === "u") { stop(); const ed = killToStart(sel()); if (ed) apply(ed); return; }
    if (ctrl && k === "w") { stop(); const ed = killWordBack(sel()); if (ed) apply(ed); return; }
    if (ctrl && k === "y") {
      stop();
      const t = kills.current[0];
      if (!t) return;
      const s = sel();
      apply({ from: s.start, to: s.end, insert: t });
      yank.current = { from: s.start, to: s.start + t.length, i: 0 };
      return;
    }
    if (alt && e.code === "KeyY") {
      stop();
      const y = yank.current;
      if (!y || kills.current.length < 2) return;
      const i = (y.i + 1) % kills.current.length;
      const t = kills.current[i];
      apply({ from: y.from, to: y.to, insert: t });
      yank.current = { from: y.from, to: y.from + t.length, i };
      return;
    }
    // Option の文字（∫ など）が入らないよう、e.code で見る
    if (alt && e.code === "KeyB") { stop(); moveTo(wordBack(sel())); return; }
    if (alt && e.code === "KeyF") { stop(); moveTo(wordForward(sel())); return; }
    if (alt && e.code === "KeyD") { stop(); const ed = killWordForward(sel()); if (ed) apply(ed); return; }
    if (e.ctrlKey && !e.metaKey && (k === "_" || (e.shiftKey && k === "-"))) { stop(); document.execCommand("undo"); return; }

    // 退避
    if (ctrl && k === "s") {
      stop();
      const st = stashes.get(agent.id);
      if (text) { stashes.set(agent.id, text); replaceAll(""); }
      else if (st != null) { stashes.delete(agent.id); replaceAll(st); }
      return;
    }

    // 止める・消す
    if (ctrl && k === "c") {
      if (ta.current && ta.current.selectionStart !== ta.current.selectionEnd && !running) return;
      stop();
      if (running && canInterrupt) { interrupt(); return; }
      if (text) clearDraft();
      return;
    }
    if (plain && k === "Escape") {
      stop();
      if (help) { setHelp(false); return; }
      if (running && canInterrupt) { interrupt(); return; }
      const now = Date.now();
      if (text && now - lastEsc.current < DOUBLE_MS) { lastEsc.current = 0; clearDraft(); return; }
      lastEsc.current = now;
      return;
    }

    // 空のときの ? はキーの一覧
    if (k === "?" && !text && !e.ctrlKey && !e.metaKey) { stop(); setHelp((h) => !h); return; }
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

  // Ctrl+R の検索
  const searchMatch = search && search.idx >= 0 ? searchList[search.idx] : null;
  const runSearch = (query: string, from: number) => {
    const idx = searchHistory(searchList, query, from);
    setSearch((s) => (s ? { ...s, query, idx: idx >= 0 ? idx : query === s.query ? s.idx : -1 } : s));
  };
  const endSearch = (keep: boolean) => {
    if (!search || searchEnding.current) return;
    searchEnding.current = true;
    const t = keep && searchMatch != null ? searchMatch : search.original;
    setSearch(null);
    replaceAll(t);
    requestAnimationFrame(() => ta.current?.focus());
    return t;
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (ctrl && e.key === "r") { e.preventDefault(); if (search) runSearch(search.query, search.idx + 1); return; }
    if (e.key === "Enter") { e.preventDefault(); const t = endSearch(true); if (t) submit(t); return; }
    if (e.key === "Tab" || e.key === "Escape") { e.preventDefault(); endSearch(true); return; }
    if (ctrl && e.key === "c") { e.preventDefault(); endSearch(false); return; }
    if (e.key === "Backspace" && !search?.query) { e.preventDefault(); endSearch(false); }
  };

  // 画像とファイル（#64）。ccn の送信は文しか受けないので、手元のファイルのパスを文として入れる。受け手の Claude はパスを読む
  const putText = (t: string) => {
    if (!alive.current || !ta.current) return;
    const s = sel();
    apply({ from: s.start, to: s.end, insert: t });
  };
  const putPaths = (paths: string[]) => {
    if (!alive.current || !ta.current) return;
    const ed = insertPaths(sel(), paths);
    if (ed) apply(ed);
  };
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    // 文だけの貼り付けは、今までどおり textarea に任せる
    if (![...cd.items].some((i) => i.kind === "file")) return;
    const plain = cd.getData("text/plain");
    e.preventDefault();
    if (!local) { if (plain) putText(plain); else onError(REMOTE_FILES); return; }
    // Finder でコピーしたファイルは、webview からは名前しか見えないので、クリップボードを Rust で読む。
    // ファイルが無く、文も無いときだけ画像を保存する（表計算のセルのように、文と絵の両方が載っているものは文を入れる）
    invoke<Pasted | null>("paste_clipboard", { saveImage: !plain })
      .then((r) => {
        const paths = r?.files?.length ? r.files : r?.image ? [r.image] : [];
        if (paths.length) putPaths(paths);
        else if (plain) putText(plain);
        else onError("クリップボードの画像を読めなかった");
      })
      .catch((err) => { if (plain) putText(plain); else onError(`貼り付けられなかった: ${err}`); });
  };
  // ドロップは窓のどこに落としても、開いている入力欄に入れる
  const dropRef = useRef({ local, canSend: agent.canSend, putPaths, onError });
  dropRef.current = { local, canSend: agent.canSend, putPaths, onError };
  useEffect(() => onFileDrop((e) => {
    if (e.type === "enter") setDropping(true);
    else if (e.type === "leave") setDropping(false);
    else if (e.type === "drop") {
      setDropping(false);
      const d = dropRef.current;
      if (!e.paths?.length || !d.canSend) return;
      if (!d.local) { d.onError(REMOTE_FILES); return; }
      d.putPaths(e.paths);
    }
  }), []);

  const shell = text.startsWith("!");
  const cmdAtStart = text.startsWith("/");
  const note = (shell || cmdAtStart) && !hasTerm
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
                  <span className="cm-name">/{c.name}{c.argumentHint ? <em> {c.argumentHint}</em> : null}</span>
                  <span className="cm-desc">{c.description}{c.source !== "builtin" ? ` (${c.source})` : ""}</span>
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
        <button className="send" disabled={!agent.canSend || busy || !text.trim()} onClick={() => submit(text)} title="送る（Enter）">
          <SendIcon />
        </button>
      </div>
      <div className="hint">{note}</div>
    </>
  );
}

function SendIcon() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 11.5 20.5 4l-5 17-3.6-7.2z" /><path d="M11.9 13.8 20.5 4" stroke="#fff" strokeWidth="1.4" /></svg>);
}
