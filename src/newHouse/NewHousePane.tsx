import { useCallback, useEffect, useState } from "react";
import { call as invoke } from "../bridge";
import { lastTermSize } from "../term/size";
import { perfMark, perfSetId, perfStart } from "../term/perf";
import { benchName } from "../term/bench";
import { onVisibleChange } from "../visible";
import { DEFAULT_PLACE_LABEL, placeFailure } from "./placeSetting";
import { placeLabel, placeName, placeTime, recentPlaces, type PlaceRepos, type PlacesInput, type RecentPlace } from "./places";

/**
 * 新しい世帯（親なしの端末のセッション）を手元のノードに立てる。cwd が null なら ~/Documents/meta（Rust の create_session の既定）。
 * 町の「＋ 新しい世帯」（#89 より前）と同じ呼び方で、前に開いたターミナルの大きさで起動する
 */
export async function createHousehold(cwd: string | null): Promise<any> {
  perfStart("new");
  const { cols, rows } = lastTermSize() ?? { cols: null, rows: null };
  const r = await invoke<any>("create_session", { cwd, prompt: null, parent: null, name: benchName(), cols, rows, peer: null });
  perfMark("create");
  if (r?.id) perfSetId(r.id);
  return r;
}

type Load = { state: "loading" } | { state: "ok"; list: RecentPlace[] } | { state: "error"; msg: string };

/**
 * 左のペイン（#89）。新しい世帯を作るためだけのペインで、最近使った場所を新しい順に出し、押した場所で親を立てる。
 * 先頭の「＋ 新しい世帯」は一覧を待たずに押せる。立てる場所は設定（place、#92）で、無ければ ~/Documents/meta。disabled は別の町を見ているとき（世帯は手元のノードにだけ作る）
 */
export function NewHousePane({ disabled, place, onCreated, onError }: { disabled: boolean; place: string | null; onCreated: (r: any) => void; onError: (m: string) => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // 立てている場所。"" は先頭のボタン（既定の場所）
  const [busy, setBusy] = useState<string | null>(null);
  // 連携しているリポジトリ名（#99）。一覧とは別に読み、読めなくても（ブラウザ版など）ディレクトリ名だけで出す
  const [repos, setRepos] = useState<PlaceRepos>({});
  const reload = useCallback(() => {
    invoke<PlacesInput>("house_places")
      .then((v) => {
        const list = v ? recentPlaces(v) : [];
        setLoad({ state: "ok", list });
        invoke<PlaceRepos>("place_repos", { paths: list.map((p) => p.path) }).then((r) => setRepos(r ?? {})).catch(() => setRepos({}));
      })
      .catch((e) => setLoad((l) => (l.state === "ok" ? l : { state: "error", msg: String(e) })));
  }, []);
  // 開いたときと、窓が見えるようになったときに読み直す（places は ccn が10秒覚えるので、続けて読んでも走査し直さない）
  useEffect(() => { reload(); return onVisibleChange((v) => { if (v) reload(); }); }, [reload]);

  const go = async (cwd: string | null, top = false) => {
    setBusy(top ? "" : cwd);
    try { onCreated(await createHousehold(cwd)); reload(); }
    // 先頭のボタン（top）は設定の場所で立てるので、失敗の通知に設定の場所を添える。一覧の行は押した場所そのもの
    catch (e) { onCreated(null); onError(placeFailure(top ? place : null, e)); }
    finally { setBusy(null); }
  };
  const off = disabled || busy !== null;

  return (
    <aside className="nh">
      <div className="nh-head">
        <span className="nh-title">新しい世帯</span>
      </div>
      <div className="nh-top">
        <button className="pane-btn new-house nh-new" disabled={off} onClick={() => go(place, true)} title={`${place ? placeLabel(place) : DEFAULT_PLACE_LABEL} で親を立てる（場所は右上の設定で変えられる）`}>
          {busy === "" ? "立てている…" : "＋ 新しい世帯"}
        </button>
        {disabled && <p className="nh-note">別の町を見ている間は作れない。新しい世帯は、このMacの町にだけ作る</p>}
      </div>
      <div className="nh-sub">最近の場所</div>
      <div className="nh-list">
        {load.state === "loading" && <p className="nh-note">読み込み中…</p>}
        {load.state === "error" && (
          <p className="nh-note bad" title={load.msg}>一覧を読めなかった。<button className="lnk" onClick={reload}>読み直す</button></p>
        )}
        {load.state === "ok" && load.list.length === 0 && <p className="nh-note">最近使った場所が無い</p>}
        {load.state === "ok" && load.list.map((p) => (
          <button key={p.path} className="nh-row" disabled={off} onClick={() => go(p.path)} title={`${placeLabel(p.path)}${repos[p.path] ? `\n${repos[p.path]}` : ""}\nで親を立てる`}>
            <span className="nh-name">{placeName(p.path)}</span>
            {repos[p.path] && <span className="nh-repo">{repos[p.path]}</span>}
            <span className="nh-time">{busy === p.path ? "立てている…" : placeTime(p.at)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
