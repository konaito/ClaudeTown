// チャット欄の「送信先」の行に置く、モデルと権限モードの切り替え（#97、always-switch）。決まりは control.ts。
// 選択はいつでも押せる。今は替えられなければ予約し、予約中であることと、いつ替えるかを下に出す。今の値を選び直すと予約を取り消す。
// - アプリ（Tauri）: 今の値と予約は Rust の session_settings で読む（switch.rs）。アプリの端末は switch_session で替えるか予約する。
//   アプリの外のセッションは、transcript から読んだ今の値を出し、選んだら代わりの手（そのターミナルで /model を打つ、など）を出す
// - ブラウザ版（PWA）の ccn の行: 今の値は ccn の GET /api/sessions/<id>（session_detail）で読み、替えたら PATCH の応答で置き換える。予約は reserve.ts
import { useEffect, useRef, useState } from "react";
import { call as invoke, IS_WEB } from "../bridge";
import type { Agent } from "../model";
import { modelOptions, modeOptions, planOf, routeOf, supportOf, viaCcn, type Plan, type Support, type What } from "./control";
import { cancel as cancelCcn, configure, reserve as reserveCcn, usePending } from "./reserve";

// ノードごとに、口があるかを覚える。あれば以後は確かめない。無ければ1分たったら確かめ直す（ノードを新しくしたとき）
const supportByNode = new Map<string, { v: Support; at: number }>();
const RECHECK_NO_MS = 60_000;

type Cur = { model: string | null; mode: string | null };
type Pend = { model?: string; mode?: string };
/** Rust の switch::status が返す形 */
type Settings = { model: string | null; permissionMode: string | null; pending: { model: string | null; permissionMode: string | null }; last: { what: What; value: string; ok: boolean; error?: string; at: number } | null };

/** 予約を当てる見張り（reserve.ts）が使う。ノードは1つなので、どのセッションも同じ値 */
export const supportFor = (a: Agent): Support => cachedSupport(viaCcn(a) ? a.kind : "terminal", "");

const cachedSupport = (kind: Agent["kind"], nodeKey: string): Support => {
  if (kind === "terminal") return "no";
  const c = supportByNode.get(nodeKey);
  return c && (c.v === "yes" || Date.now() - c.at < RECHECK_NO_MS) ? c.v : "unknown";
};

/**
 * このセッションのノードに、モデルの切り替えとコマンドの口があるか（ノードごとに1回確かめる）。
 * 2つ目の戻り値は、使ったときに 404 が返ったら「無い」に直す口
 */
export function useNodeSupport(agent: Agent | null): [Support, () => void] {
  const nodeKey = "";
  const id = agent?.id ?? "";
  // ブラウザ版（PWA）の ccn の行のほかは、ccn の口が無いので確かめない
  const kind = agent && viaCcn(agent) ? agent.kind : "terminal";
  const [support, setSupport] = useState<Support>(() => cachedSupport(kind, nodeKey));
  useEffect(() => {
    const v = cachedSupport(kind, nodeKey);
    setSupport(v);
    if (!id || v !== "unknown") return;
    let on = true;
    invoke<unknown>("session_controls", { sessionId: id })
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

export function SessionControls({ agent, support, onNoSupport, onSwitching, onDone, onError }: {
  agent: Agent;
  support: Support; onNoSupport: () => void;
  /** 替えている間（ccn の pty は起動し直しの約3秒）。この間はチャットの送信も止める */
  onSwitching: (on: boolean) => void;
  onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const route = routeOf(agent);
  const [cur, setCur] = useState<Cur>({ model: null, mode: null });
  const [switching, setSwitching] = useState(false);
  // アプリの端末の予約（Rust が持つ）。ccn の行の予約は reserve.ts が持つ
  const [appPend, setAppPend] = useState<Pend>({});
  const ccnPend = usePending(agent.id);
  const pend: Pend = route === "app" ? appPend : route === "ccn" ? ccnPend : {};
  // 外から届ける口が無いセッションで選んだときの、代わりの手
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // 最後の結果は1回だけ知らせる。開いたときに残っていた結果は知らせない
  const seenAt = useRef<number | null | undefined>(undefined);

  const take = (s: Settings) => {
    if (!alive.current || !s || typeof s !== "object") return;
    setCur({ model: str(s.model), mode: str(s.permissionMode) });
    setAppPend({ model: str(s.pending?.model) ?? undefined, mode: str(s.pending?.permissionMode) ?? undefined });
    const at = s.last?.at ?? null;
    if (seenAt.current !== undefined && at && at !== seenAt.current && s.last) {
      const label = s.last.what === "model" ? "モデル" : "権限モード";
      if (s.last.ok) onDone(`${agent.name} の${label}を ${s.last.value} にした`);
      else onError(`${agent.name}: ${label}を ${s.last.value} にできなかった: ${s.last.error ?? ""}`);
    }
    seenAt.current = at;
  };

  // 今の値。開いたとき、状態が変わったとき（承認に答えた後、計画の承認でモードが替わる）に読み直す。
  // アプリの端末で予約がある間は、1秒ごとに読む（当たったら予約が消える）
  const hasPend = !!(appPend.model || appPend.mode);
  useEffect(() => {
    let on = true;
    const read = () => {
      if (IS_WEB) {
        invoke<any>("session_detail", { sessionId: agent.id })
          .then((d) => { if (on && d && typeof d === "object") setCur({ model: str(d.model), mode: str(d.permissionMode) }); })
          .catch(() => {});
      } else {
        invoke<Settings>("session_settings", { sessionId: agent.id }).then((s) => { if (on) take(s); }).catch(() => {});
      }
    };
    read();
    const t = route === "app" && hasPend ? setInterval(read, 1000) : null;
    return () => { on = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, agent.state, route, hasPend]);

  const planFor = (what: What, v: string | null): Plan => planOf(agent, what, v, support, switching);

  const applyCcn = async (what: What, v: string) => {
    setSwitching(true);
    onSwitching(true);
    const r = await configure(agent, what, v);
    if (alive.current) setSwitching(false);
    onSwitching(false);
    if (!r.ok) {
      if (r.noRoute) onNoSupport();
      onError(`${agent.name}: ${r.error}`);
      return;
    }
    if (alive.current) setCur({ model: r.model, mode: r.mode });
    onDone(what === "model" ? `${agent.name} のモデルを ${v} にした` : `${agent.name} の権限モードを ${v} にした`);
  };

  const choose = async (what: What, v: string) => {
    setNote(null);
    const now = what === "model" ? cur.model : cur.mode;
    // 今の値を選び直したら、予約を取り消す
    if (v === now) {
      if (!pend[what]) return;
      if (route === "app") take(await invoke<Settings>("cancel_switch", { sessionId: agent.id, what }));
      else cancelCcn(agent.id, what);
      onDone(`${agent.name} の${what === "model" ? "モデル" : "権限モード"}の予約を取り消した`);
      return;
    }
    const plan = planFor(what, v);
    if (plan.kind === "none") { setNote(plan.why); return; }
    if (route === "app") {
      try {
        take(await invoke<Settings>("switch_session", { sessionId: agent.id, model: what === "model" ? v : null, permissionMode: what === "mode" ? v : null }));
      } catch (e) {
        onError(`${agent.name}: ${e}`);
      }
      return;
    }
    if (plan.kind === "wait") { reserveCcn(agent.id, what, v); return; }
    await applyCcn(what, v);
  };

  // 予約中の文。すぐ当てられる予約は「替えている」と出す（アプリの端末は、Rust の見張りが0.5秒以内に当てる）
  const lines: string[] = [];
  for (const what of ["model", "mode"] as What[]) {
    const v = pend[what];
    if (!v) continue;
    const p = planFor(what, v);
    const label = what === "model" ? "モデル" : "権限モード";
    lines.push(p.kind === "wait" ? `${label}を ${v} に予約した。${p.when}` : `${label}を ${v} に替えている`);
  }
  if (note) lines.push(note);
  if (switching && route === "ccn") lines.push(agent.kind === "pty" ? "起動し直している（約3秒）" : "替えている");

  const tip = (what: What) => {
    const label = what === "model" ? "モデル" : "権限モード";
    const p = planFor(what, null);
    if (p.kind === "none") return `${label}: ${p.why}`;
    const when = p.kind === "wait" ? `いまは替えられないので予約する（${p.when}）` : "すぐ替える";
    if (route === "app") {
      return what === "model"
        ? `${label}を替える（${when}）。端末に /model を打つのと同じで、新しいセッションの既定にもなる（Claude Code の動き）`
        : `${label}を替える（${when}）。端末で Shift+Tab を押すのと同じ。dontAsk は端末からは選べない`;
    }
    return `${label}を替える（${when}）。` + (agent.kind === "pty" ? "端末のセッションは claude を起動し直す（約3秒。裏のシェルとサブエージェントは止まる）" : "このセッションだけに効き、設定ファイルは書き換えない");
  };
  const shownModel = pend.model ?? cur.model;
  const shownMode = pend.mode ?? cur.mode;
  return (
    <div className="sc">
      {lines.map((l) => <span key={l} className="sc-why" title={l}>{l}</span>)}
      <select className={`sc-sel ${pend.model ? "sc-pend" : ""}`} aria-label="モデル" value={shownModel ?? ""} title={tip("model")}
        onChange={(e) => { const v = e.target.value; if (v) void choose("model", v); }}>
        {!shownModel && <option value="">モデル</option>}
        {withCur(modelOptions(shownModel), cur.model).map((m) => <option key={m.value} value={m.value}>{m.value === cur.model && pend.model ? `${m.label}（今）` : m.label}</option>)}
      </select>
      <select className={`sc-sel ${pend.mode ? "sc-pend" : ""}`} aria-label="権限モード" value={shownMode ?? ""} title={tip("mode")}
        onChange={(e) => { const v = e.target.value; if (v) void choose("mode", v); }}>
        {!shownMode && <option value="">権限モード</option>}
        {withCur(modeOptions(shownMode), cur.mode).map((m) => <option key={m.value} value={m.value} title={(m as { title?: string }).title ?? m.label}>{m.value === cur.mode && pend.mode ? `${m.label}（今）` : m.label}</option>)}
      </select>
    </div>
  );
}

/** 予約中は選択肢の先頭に予約の値が来るので、今の値が候補に無ければ（id のモデルなど）足す。選び直して取り消せるように */
function withCur<T extends { value: string; label: string }>(opts: T[], cur: string | null): T[] {
  if (!cur || opts.some((o) => o.value === cur)) return opts;
  return [{ value: cur, label: cur.replace(/^claude-/, "") } as T, ...opts];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
