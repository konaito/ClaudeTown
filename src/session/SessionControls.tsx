// チャット欄の「送信先」の行に置く、モデルと権限モードの切り替え（#97）。決まりは control.ts。
// 今の値は ccn の GET /api/sessions/<id>（session_detail）の model と permissionMode で読み、替えたら PATCH の応答で置き換える。
// 一覧（snapshot）には載せない（Rust の一覧の取り込みは別の作業が触っているので、こちらは詳細を読む）。
import { useEffect, useRef, useState } from "react";
import { call as invoke } from "../bridge";
import type { Agent } from "../model";
import { configureError, isHttp, lockReason, noRoute, viaCcn, modelOptions, modeOptions, showReason, supportOf, type Support } from "./control";

// ノードごとに、口があるかを覚える。あれば以後は確かめない。無ければ1分たったら確かめ直す（ノードを新しくしたとき）
const supportByNode = new Map<string, { v: Support; at: number }>();
const RECHECK_NO_MS = 60_000;

type Cur = { model: string | null; mode: string | null };

const cachedSupport = (kind: Agent["kind"], nodeKey: string): Support => {
  if (kind === "terminal") return "no";
  const c = supportByNode.get(nodeKey);
  return c && (c.v === "yes" || Date.now() - c.at < RECHECK_NO_MS) ? c.v : "unknown";
};

/**
 * このセッションのノードに、モデルの切り替えとコマンドの口があるか（ノードごとに1回確かめる）。
 * 2つ目の戻り値は、使ったときに 404 が返ったら「無い」に直す口
 */
export function useNodeSupport(agent: Agent | null, peer: string): [Support, () => void] {
  const nodeKey = peer || "";
  const id = agent?.id ?? "";
  const kind = agent?.kind ?? "terminal";
  const [support, setSupport] = useState<Support>(() => cachedSupport(kind, nodeKey));
  useEffect(() => {
    const v = cachedSupport(kind, nodeKey);
    setSupport(v);
    if (!id || v !== "unknown") return;
    let on = true;
    invoke<unknown>("session_controls", { sessionId: id, peer: peer || null })
      .then((r) => {
        const got = supportOf(r);
        if (got !== "unknown") supportByNode.set(nodeKey, { v: got, at: Date.now() });
        // 分からなかったとき（ブラウザ表示、中継の失敗）は、使えないものとして出す。次にセッションを開いたときに確かめ直す
        if (on) setSupport(got === "unknown" ? "no" : got);
      })
      .catch(() => { if (on) setSupport("no"); });
    return () => { on = false; };
  }, [id, kind, nodeKey]);
  const markNo = () => { supportByNode.set(nodeKey, { v: "no", at: Date.now() }); setSupport("no"); };
  return [support, markNo];
}

export function SessionControls({ agent, peer, support, onNoSupport, onSwitching, onDone, onError }: {
  agent: Agent; peer: string;
  support: Support; onNoSupport: () => void;
  /** 替えている間（pty は起動し直しの約3秒）。この間はチャットの送信も止める */
  onSwitching: (on: boolean) => void;
  onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [cur, setCur] = useState<Cur>({ model: null, mode: null });
  const [switching, setSwitching] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // 今の値。開いたとき、状態が変わったとき（承認に答えた後、計画の承認でモードが替わる）に読み直す
  useEffect(() => {
    let on = true;
    invoke<any>("session_detail", { sessionId: agent.id, peer: peer || null })
      .then((d) => { if (on && d && typeof d === "object") setCur({ model: str(d.model), mode: str(d.permissionMode) }); })
      .catch(() => {});
    return () => { on = false; };
  }, [agent.id, peer, agent.state]);

  const reason = lockReason(agent, support, switching);
  const apply = async (change: { model?: string; permissionMode?: string }) => {
    if (reason) return;
    setSwitching(true);
    onSwitching(true);
    try {
      const r = await invoke<unknown>("configure_session", { sessionId: agent.id, model: change.model ?? null, permissionMode: change.permissionMode ?? null, peer: peer || null });
      if (!isHttp(r)) throw new Error("ccn の応答が読めなかった");
      const err = configureError(r);
      if (err) {
        if (noRoute(r)) onNoSupport();
        onError(`${agent.name}: ${err}`);
        return;
      }
      if (alive.current) setCur({ model: str(r.body?.model), mode: str(r.body?.permissionMode) });
      onDone(change.model ? `${agent.name} のモデルを ${change.model} にした` : `${agent.name} の権限モードを ${change.permissionMode} にした`);
    } catch (e) {
      onError(`${agent.name}: 替えられなかった: ${e}`);
    } finally {
      if (alive.current) setSwitching(false);
      onSwitching(false);
    }
  };

  const tip = (what: string) => reason ?? (agent.kind === "pty" ? `${what}を替える。端末のセッションは claude を起動し直す（約3秒。裏のシェルとサブエージェントは止まる）` : `${what}を替える。このセッションだけに効き、設定ファイルは書き換えない`);
  return (
    <div className="sc">
      {showReason(reason, support) && <span className="sc-why" title={reason!}>{reason}</span>}
      <select className="sc-sel" aria-label="モデル" value={cur.model ?? ""} disabled={!!reason} title={tip("モデル")}
        onChange={(e) => { const v = e.target.value; if (v && v !== cur.model) apply({ model: v }); }}>
        {!cur.model && <option value="">モデル</option>}
        {modelOptions(cur.model).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <select className="sc-sel" aria-label="権限モード" value={cur.mode ?? ""} disabled={!!reason} title={tip("権限モード")}
        onChange={(e) => { const v = e.target.value; if (v && v !== cur.mode) apply({ permissionMode: v }); }}>
        {!cur.mode && <option value="">権限モード</option>}
        {modeOptions(cur.mode).map((m) => <option key={m.value} value={m.value} title={m.title}>{m.label}</option>)}
      </select>
    </div>
  );
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
