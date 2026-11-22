import { useEffect, useState } from "react";
import { call as invoke } from "../bridge";
import { checkPlace, DEFAULT_PLACE_LABEL } from "../newHouse/placeSetting";
import { placeLabel, recentPlaces, type PlacesInput, type RecentPlace } from "../newHouse/places";
import { MODELS, MODES } from "../session/control";
import type { SessionDefaults } from "../session/defaults";

/**
 * 設定の画面（#92）。ヘッダーの右端の歯車から開くモーダル。項目は「新しい世帯の場所」と「新しい世帯のモデルと権限モード」。
 * 項目を足すときは、<section className="set-sec"> を1つ足し、保存する値を onSave の引数に足す。
 */
export function SettingsDialog({ place, defaults, onSave, onClose }: {
  place: string | null; defaults: SessionDefaults;
  onSave: (place: string | null, defaults: SessionDefaults) => void; onClose: () => void;
}) {
  // 入力欄の文字。空は「設定しない（既定）」
  const [text, setText] = useState(place ?? "");
  // 新しい世帯を立てるときのモデルと権限モード。"" は「設定しない」（ノードの Claude Code の既定）
  const [model, setModel] = useState(defaults.model ?? "");
  const [mode, setMode] = useState(defaults.permissionMode ?? "");
  const [src, setSrc] = useState<{ roots: string[]; lobby: string | null; recent: RecentPlace[] } | "error" | null>(null);
  useEffect(() => {
    let live = true;
    invoke<PlacesInput>("house_places")
      .then((v) => live && setSrc(v ? { roots: v.roots, lobby: v.lobby, recent: recentPlaces(v) } : { roots: [], lobby: null, recent: [] }))
      .catch(() => live && setSrc("error"));
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  // 範囲の確認（ブラウザ版の ccn の roots）は一覧を読めてから。読めなかったときは範囲を確かめず、立てたときの失敗で伝える
  const roots = typeof src === "object" && src ? src.roots : [];
  const lobby = typeof src === "object" && src ? src.lobby : null;
  const check = text.trim() ? checkPlace(text, roots, lobby) : null;
  const bad = check && !check.ok ? check.reason : null;
  const save = () => {
    if (bad) return;
    onSave(check && check.ok ? check.path : null, { model: model || null, permissionMode: mode || null });
    onClose();
  };

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal set-modal" role="dialog" aria-modal="true" aria-label="設定" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">設定</div>
        <section className="set-sec">
          <label className="set-label" htmlFor="set-place">新しい世帯の場所</label>
          <p className="hint">左のペインの「新しい世帯」を押したときに、親を立てる場所。空にすると {DEFAULT_PLACE_LABEL} で立てる。</p>
          <input id="set-place" className="set-input" value={text} spellCheck={false} placeholder={`${DEFAULT_PLACE_LABEL}（既定）`} autoFocus
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} aria-invalid={!!bad} />
          {bad && <p className="set-bad">{bad}</p>}
          <div className="set-sub">最近の場所から選ぶ</div>
          <div className="set-list">
            <button className={`nh-row${!text.trim() ? " on" : ""}`} onClick={() => setText("")}>
              <span className="nh-time">既定</span><span className="nh-path">{DEFAULT_PLACE_LABEL}</span>
            </button>
            {src === null && <p className="nh-note">読み込み中…</p>}
            {src === "error" && <p className="nh-note bad">一覧を読めなかった。場所は直接入力できる（無い場所なら、立てるときに知らせる）</p>}
            {typeof src === "object" && src && src.recent.map((p) => (
              <button key={p.path} className={`nh-row${text.trim() === p.path ? " on" : ""}`} onClick={() => setText(p.path)} title={p.path}>
                <span className="nh-path">{placeLabel(p.path)}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="set-sec">
          <span className="set-label">新しい世帯のモデルと権限モード</span>
          <p className="hint">世帯を立てたとき、まだチャットが無い段階で選ばれている値。送信先の行で選び直すと、その会話では選んだ値になる。「設定しない」はこの Mac の Claude Code の既定で立てる。</p>
          <div className="set-row">
            <label className="set-pair">
              <span className="set-sub">モデル</span>
              <select className="set-input" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">設定しない</option>
                {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label className="set-pair">
              <span className="set-sub">権限モード</span>
              <select className="set-input" value={mode} onChange={(e) => setMode(e.target.value)} title={MODES.find((m) => m.value === mode)?.title}>
                <option value="">設定しない</option>
                {MODES.map((m) => <option key={m.value} value={m.value} title={m.title}>{m.label}</option>)}
              </select>
            </label>
          </div>
        </section>
        <div className="modal-btns">
          <button className="pane-btn" onClick={onClose}>やめる（Esc）</button>
          <button className="primary" disabled={!!bad} onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
