import { useEffect, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent, Peer } from "../model";
import type { TeleportInfo, TeleportPlan, TeleportResult } from "../types";

/**
 * 転出（ccn の teleport）。行き先のノードと move / fork を選び、下見（移動元の説明）を見てから実行する。
 * 実行は1回の要求で最大95秒かかる。行き先の下見（clone することがある）は実行の中で ccn が行う。
 */
export function Teleport({ agent, descendants, peers, onDone, onError }: { agent: Agent; descendants: Agent[]; peers: Peer[]; onDone: (m: string) => void; onError: (m: string) => void }) {
  // 子孫がいれば、子孫ごと移す（2026-11-12 本人の判断）。ccn の部分木の口（subtree）を使い、先に計画（dryRun）を見せる
  const subtree = descendants.length > 0;
  const [plan, setPlan] = useState<TeleportPlan | null>(null);
  const dests = peers.filter((p) => !p.self && p.status === "healthy");
  const [to, setTo] = useState(dests[0]?.name ?? "");
  const [fork, setFork] = useState(false);
  const [info, setInfo] = useState<TeleportInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TeleportResult | null>(null);
  useEffect(() => {
    invoke<TeleportInfo>("teleport_info", { sessionId: agent.id, peer: null }).then(setInfo).catch((e) => setInfoErr(String(e)));
  }, [agent.id]);
  useEffect(() => {
    if (!subtree || !to) { setPlan(null); return; }
    invoke<TeleportPlan>("teleport", { sessionId: agent.id, to, fork, subtree: true, dryRun: true, peer: null })
      .then(setPlan).catch((e) => setPlan({ error: String(e) }));
  }, [agent.id, to, fork, subtree]);
  // 作業中か承認待ちの人が1人でもいたら押せなくする。ccn は動いているセッションを移さず、全員が止まるまで待つと終わりが読めないため
  const busyOnes = [agent, ...descendants].filter((x) => x.state === "running" || x.state === "waiting_permission");
  const running = busyOnes.length > 0;
  const go = async () => {
    setBusy(true);
    try {
      const r = await invoke<TeleportResult>("teleport", { sessionId: agent.id, to, fork, subtree, dryRun: false, peer: null });
      setResult(r);
      if (subtree) {
        const moved = r?.moved?.length ?? 0, failed = r?.failed?.length ?? 0;
        onDone(`${agent.name} の世帯を ${to} へ${fork ? "複製" : "移動"}した（${moved}人${failed ? `、失敗 ${failed}人` : ""}）`);
      } else {
        onDone(`${agent.name} を ${r?.node ?? to} へ${fork ? "複製" : "移動"}した（新しい id ${String(r?.id ?? "").slice(0, 8)}）`);
      }
    } catch (e) { onError(`${agent.name} を転出できなかった: ${e}`); } finally { setBusy(false); }
  };
  return (
    <div className="sheet">
      <div className="sheet-title">{agent.name} を別の機械へ転出する</div>
      <div className="tp-row">
        <label>行き先</label>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {dests.length === 0 && <option value="">（つながっている機械が無い）</option>}
          {dests.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <label className="tp-radio"><input type="radio" checked={!fork} onChange={() => setFork(false)} />移す（ここは止める）</label>
        <label className="tp-radio"><input type="radio" checked={fork} onChange={() => setFork(true)} />複製（ここも残す）</label>
      </div>
      <div className="tp-info">
        {infoErr ? <span className="bad-text">下見できない: {infoErr}</span> : !info ? "下見している…" : (
          <>
            <div>状態: {info.state}{info.live ? "（動いている）" : ""}・作業場所: {String(info.from?.cwd ?? "").replace(/^\/Users\/[^/]+/, "~")}</div>
            <div>git: {info.git ? `${info.git.repoName}（${info.git.branch}）` : "git のリポジトリではない"}</div>
          </>
        )}
        {subtree && (
          <div className="tp-plan">
            <div><b>子孫 {descendants.length} 人も一緒に移る</b>（親子の関係は行き先でも保つ）</div>
            {plan?.error ? <div className="bad-text">計画を出せない: {plan.error}</div> : !plan ? <div className="hint">計画を出している…</div> : (
              <ul>{(plan.plan ?? []).map((m) => <li key={m.sourceId}>{m.title ?? m.sourceId.slice(0, 8)} → {String(m.cwd ?? "").replace(/^\/Users\/[^/]+/, "~")}</li>)}
                {(plan.skipped ?? []).map((m) => <li key={m.sourceId} className="bad-text">{m.sourceId.slice(0, 8)}: 対象外（{m.reason}）</li>)}</ul>
            )}
          </div>
        )}
        {running && <div className="bad-text">作業中か承認待ちの人がいるので転出できない（{busyOnes.map((x) => x.name).join("、")}）。全員が待機になってから転出する。</div>}
        <div className="hint">行き先に同じリポジトリが無ければ、ccn が行き先の ~/Documents に clone する。実行には最大95秒かかる。{agent.capabilities?.terminal ? "ターミナルのセッションは、行き先ではまだターミナルとして再開しない（ccn 側の対応待ち）。" : ""}</div>
      </div>
      {result ? (
        subtree ? (
          <div className="tp-result">
            {to} へ移した: {(result.moved ?? []).length}人。
            {(result.failed ?? []).length > 0 && <span className="bad-text"> 失敗: {(result.failed ?? []).map((f) => `${f.sourceId.slice(0, 8)}（${f.error}）`).join("、")}</span>}
            画面上のノードを {to} に切り替えると見える。
          </div>
        ) : (
          <div className="tp-result">行き先 {result.node} の新しい id: {result.id}{result.cloned ? "（clone した）" : ""}。画面上のノードを {result.node} に切り替えると見える。</div>
        )
      ) : (
        <div className="sheet-foot">
          <span className="hint">{subtree ? "全員を下見してから止めるので、下見で落ちたら何も変わらない" : ""}</span>
          <button className="primary" disabled={busy || !to || running || !info} onClick={go}>{busy ? "転出している…（最大95秒）" : fork ? "複製する" : "移す"}</button>
        </div>
      )}
    </div>
  );
}
