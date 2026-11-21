import { useCallback, useEffect, useState } from "react";
import { call as invoke } from "../bridge";
import { lastTermSize } from "../term/size";
import { perfMark, perfSetId, perfStart } from "../term/perf";
import { benchName } from "../term/bench";
import { onVisibleChange } from "../visible";
import { placeLabel, placeTime, recentPlaces, type PlacesInput, type RecentPlace } from "./places";

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
 * 先頭の「＋ 新しい世帯」は一覧を待たずに押せる（~/Documents/meta）。disabled は別の町を見ているとき（世帯は手元のノードにだけ作る）
 */
export function NewHousePane({ disabled, onCreated, onError }: { disabled: boolean; onCreated: (r: any) => void; onError: (m: string) => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // 立てている場所。"" は先頭のボタン（既定の場所）
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => {
    invoke<PlacesInput>("house_places")
      .then((v) => setLoad({ state: "ok", list: v ? recentPlaces(v) : [] }))
      .catch((e) => setLoad((l) => (l.state === "ok" ? l : { state: "error", msg: String(e) })));
  }, []);
  // 開いたときと、窓が見えるようになったときに読み直す（places は ccn が10秒覚えるので、続けて読んでも走査し直さない）
  useEffect(() => { reload(); return onVisibleChange((v) => { if (v) reload(); }); }, [reload]);

  const go = async (cwd: string | null) => {
    setBusy(cwd ?? "");
    try { onCreated(await createHousehold(cwd)); reload(); }
    catch (e) { onCreated(null); onError(`世帯を作れなかった: ${e}`); }
    finally { setBusy(null); }
  };
  const off = disabled || busy !== null;

  return (
    <aside className="nh">
      <div className="nh-head">
        <span className="nh-title">新しい世帯</span>
      </div>
      <div className="nh-top">
        <button className="pane-btn new-house nh-new" disabled={off} onClick={() => go(null)} title="~/Documents/meta で親を立てる">
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
          <button key={p.path} className="nh-row" disabled={off} onClick={() => go(p.path)} title={`${p.path} で親を立てる`}>
            <span className="nh-time">{busy === p.path ? "立てている…" : placeTime(p.at)}</span>
            <span className="nh-path">{placeLabel(p.path)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
