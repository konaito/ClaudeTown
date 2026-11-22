import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { ICON, STROKE } from "../icons";
import { IS_WEB, call as invoke } from "../bridge";
import { lastTermSize } from "../term/size";
import { perfMark, perfSetId, perfStart } from "../term/perf";
import { benchName } from "../term/bench";
import { onVisibleChange } from "../visible";
import { DEFAULT_PLACE_LABEL, placeFailure } from "./placeSetting";
import { RECENT_PLACES_MAX, placeLabel, placeName, placeTime, recentPlaces, withoutPlace, type PlaceRepos, type PlacesInput, type RecentPlace } from "./places";
import type { CreatedSession } from "../types";

/**
 * 新しい世帯（親なしの claude）を立てる。アプリではこのアプリの中の端末で claude を起動する（src-tauri/src/pty.rs）。
 * cwd が null なら ~/Documents/meta（Rust の create_session の既定）。前に開いたターミナルの大きさで起動する
 */
export async function createHousehold(cwd: string | null): Promise<CreatedSession> {
  perfStart("new");
  const { cols, rows } = lastTermSize() ?? { cols: null, rows: null };
  const r = await invoke<CreatedSession>("create_session", { cwd, name: benchName(), cols, rows });
  perfMark("create");
  if (r?.id) perfSetId(r.id);
  return r;
}

/**
 * 終わったセッションを、id を指定して Claude Town の端末で開き直す（#152）。場所は Rust が会話の記録（jsonl）から取る。
 * 会話の記録が無いもの、よそで同じ id が動いているものは Rust が断る
 */
export async function resumeHousehold(sessionId: string): Promise<CreatedSession> {
  const { cols, rows } = lastTermSize() ?? { cols: null, rows: null };
  return invoke<CreatedSession>("resume_session", { sessionId, cols, rows });
}

type Load = { state: "loading" } | { state: "ok"; list: RecentPlace[]; defaultPlace: string | null } | { state: "error"; msg: string };

/**
 * 左のペイン（#89）。新しい世帯を作るためだけのペインで、最近使った場所を新しい順に出し、押した場所で親を立てる。
 * 先頭の「新しい世帯」は一覧を待たずに押せる。立てる場所は設定（place、#92）で、無ければ ~/Documents/meta。
 * 一覧からは、その立てる場所を除く（withoutPlace）。見出しは出さない（2026-11-21 本人の決定）
 */
export function NewHousePane({ place, onCreated, onError }: { place: string | null; onCreated: (r: CreatedSession | null) => void; onError: (m: string) => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // 立てている場所。"" は先頭のボタン（既定の場所）
  const [busy, setBusy] = useState<string | null>(null);
  // 連携しているリポジトリ名（#99）。一覧とは別に読み、読めなくても（ブラウザ版など）ディレクトリ名だけで出す
  const [repos, setRepos] = useState<PlaceRepos>({});
  const reload = useCallback(() => {
    invoke<PlacesInput>("house_places")
      .then((v) => {
        const list = v ? recentPlaces(v, RECENT_PLACES_MAX + 1) : [];
        setLoad({ state: "ok", list, defaultPlace: v?.defaultPlace ?? null });
        invoke<PlaceRepos>("place_repos", { paths: list.map((p) => p.path) }).then((r) => setRepos(r ?? {})).catch(() => setRepos({}));
      })
      .catch((e) => setLoad((l) => (l.state === "ok" ? l : { state: "error", msg: String(e) })));
  }, []);
  // 開いたときと、窓が見えるようになったときに読み直す（Rust は履歴のファイルが変わったときだけ読み直す）
  useEffect(() => { reload(); return onVisibleChange((v) => { if (v) reload(); }); }, [reload]);

  const go = async (cwd: string | null, top = false) => {
    setBusy(top ? "" : cwd);
    try { onCreated(await createHousehold(cwd)); reload(); }
    // 先頭のボタン（top）は設定の場所で立てるので、失敗の通知に設定の場所を添える。一覧の行は押した場所そのもの
    catch (e) { onCreated(null); onError(placeFailure(top ? place : null, e)); }
    finally { setBusy(null); }
  };
  // id で開き直す欄（#152）
  const [resumeId, setResumeId] = useState("");
  const reopen = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = resumeId.trim();
    if (!id || busy !== null) return;
    setBusy("resume");
    try { onCreated(await resumeHousehold(id)); setResumeId(""); }
    catch (err) { onCreated(null); onError(`開き直せなかった: ${String(err)}`); }
    finally { setBusy(null); }
  };
  const off = busy !== null;
  // 置き場所を除いた一覧。除いても件数が減らないよう、1件多く読んでおき、ここで RECENT_PLACES_MAX 件に切る
  const shown = load.state === "ok" ? withoutPlace(load.list, place, load.defaultPlace).slice(0, RECENT_PLACES_MAX) : [];

  return (
    <aside className="nh">
      <div className="nh-top">
        <button className="pane-btn new-house nh-new" disabled={off} onClick={() => go(place, true)} title={`${place ? placeLabel(place) : DEFAULT_PLACE_LABEL} で親を立てる（場所は右上の設定で変えられる）`}>
          {busy === "" ? "立てている…" : <><Plus size={ICON.md} strokeWidth={STROKE} aria-hidden />新しい世帯</>}
        </button>
      </div>
      <div className="nh-sub">最近の場所</div>
      <div className="nh-list">
        {load.state === "loading" && <p className="nh-note">読み込み中…</p>}
        {load.state === "error" && (
          <p className="nh-note bad" title={load.msg}>一覧を読めなかった。<button className="lnk" onClick={reload}>読み直す</button></p>
        )}
        {load.state === "ok" && shown.length === 0 && <p className="nh-note">最近使った場所が無い</p>}
        {shown.map((p) => (
          <button key={p.path} className="nh-row" disabled={off} onClick={() => go(p.path)} title={`${placeLabel(p.path)}${repos[p.path] ? `\n${repos[p.path]}` : ""}\nで親を立てる`}>
            <span className="nh-name">{placeName(p.path)}</span>
            {repos[p.path] && <span className="nh-repo">{repos[p.path]}</span>}
            <span className="nh-time">{busy === p.path ? "立てている…" : placeTime(p.at)}</span>
          </button>
        ))}
      </div>
      {!IS_WEB && (
        <form className="nh-resume" onSubmit={reopen}>
          <input className="set-input" value={resumeId} onChange={(e) => setResumeId(e.target.value)} disabled={off}
            placeholder="セッション id で開き直す" aria-label="Claude Town で開き直すセッションの id" spellCheck={false}
            title="終わったセッションの id を入れて Enter。前と同じ場所で claude --resume を起動する" />
          {busy === "resume" && <span className="nh-note">開いている…</span>}
        </form>
      )}
    </aside>
  );
}
