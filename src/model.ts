// Rust の snapshot が返す形と、そこからキャラの様子（mood）と表示の文を決める規則。

export type Report = {
  phase?: "working" | "needs_you" | "resting";
  asked?: string;
  doing?: string | null;
  said?: string;
  next?: string | null;
  needs?: string | null;
  tools?: number;
  turn_started_at?: number;
  updated_at?: number;
  /** これから使う道具（承認を求められたら、これが中身） */
  pending?: { tool: string; summary: string; detail: string; id?: string | null } | null;
  /** 承認の画面が出ている（出る予定の）道具の数。2件以上なら画面からは許可しない */
  pending_count?: number;
  perm_queue?: { tool: string; summary: string; detail: string; id: string }[];
};

export type Agent = {
  id: string;
  name: string;
  kind: "terminal" | "node";
  state: "running" | "waiting_permission" | "idle";
  cwd: string;
  pid?: number;
  startedAt?: number;
  /** ccn が最後に動きを見た時刻（ms） */
  lastActivityAt?: number;
  canSend: boolean;
  parent: string | null;
  /** ccn の parent の生の値（agent:<ノード>/<親の sid8>/<役割> か local） */
  parentRaw?: string | null;
  /** 転出のゴースト（src/ghost.ts）。相手の町にいる本物の ID と、親か子か */
  ghost?: { town: string; realId: string; role: "parent" | "child" } | null;
  capabilities?: { send?: boolean; permissions?: boolean; interrupt?: boolean; stop?: boolean; terminal?: boolean } | null;
  report?: Report | null;
  closeCheck?: { status: "working" | "checking" | "ok" | "ng" | "error"; short?: string | null } | null;
  /** キャラの絵（Rust が町の中で被らないように割り当てる）。hue は色相のずらし（度） */
  avatar?: { char: string; hue: number } | null;
  /** 世帯の名前（根のセッションだけ意味がある）。by=human は本人がアプリで付けた名前 */
  house?: { name: string; by: "agent" | "human" } | null;
};

export type Snapshot = {
  ccn: string;
  peer: string | null;
  ccn_ok: boolean;
  ccn_error: string | null;
  agents: Agent[];
  /** お手紙の最近の記録（この機械の町だけ。src/letters.ts） */
  letters?: import("./letters").LetterRec[];
  fetched_at: number;
};

export type Peer = { name: string; url: string; status: string; self: boolean };

export type ConvItem = {
  role: "user" | "assistant" | "tool"; text: string; from?: string | null; at?: string | number | null; pending?: boolean;
  /** 通し番号（このセッションで何件目か。Rust の conversation が付ける）。吹き出しの key に使う。送ったばかりの仮の項目には無い */
  n?: number;
  /** 別のセッションからのお手紙なら、送り手（from-name と、uds のソケットか agent:<ノード>/<sid8>/<役割>） */
  letter?: { fromName?: string | null; fromRaw?: string | null } | null;
  /** 送ったお手紙（role が tool のとき）。宛先は生のまま。create は子を作って最初の文を渡したもの */
  sent?: { to?: string | null; peer?: string | null; summary?: string; text?: string | null; create?: boolean } | null;
};

/**
 * キャラの様子。
 * approval=承認待ち（ペインで答える）、reply=返事待ち（ここから答えられる）、working=作業中、done=完了、idle=待機
 */
export type Mood = "approval" | "reply" | "working" | "done" | "idle";

export function moodOf(a: Agent): Mood {
  if (a.state === "waiting_permission") return "approval";
  if (a.state === "running") return "working";
  if (a.report?.phase === "needs_you") return "reply";
  if (a.closeCheck?.status === "ok") return "done";
  return "idle";
}

export const MOOD_LABEL: Record<Mood, string> = {
  approval: "承認待ち",
  reply: "返事待ち",
  working: "作業中",
  done: "完了",
  idle: "待機",
};

export const NEEDS_YOU: Mood[] = ["approval", "reply"];

/** カードの1行ラベル。その子がいま何の係かを短く */
export function taskOf(a: Agent, mood: Mood): string {
  const r = a.report;
  if (mood === "approval") return "承認を待っています";
  if (mood === "reply") return r?.next ?? r?.needs ?? "返事を待っています";
  if (mood === "done") return "完了";
  return r?.asked ?? (a.parent ? "おてつだい" : "全体をまとめる");
}

/** いまの様子の1行（作業中なら道具、待機なら理由） */
export function nowOf(a: Agent, mood: Mood): string | null {
  const r = a.report;
  switch (mood) {
    case "approval": return r?.needs ?? r?.doing ?? null;
    case "reply": return r?.said ?? r?.needs ?? null;
    case "working": return r?.doing ?? null;
    case "done": return r?.said ?? null;
    case "idle": return a.closeCheck?.short ?? r?.said ?? null;
  }
}

export function sinceText(ms?: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.round(s / 60)}分`;
  return `${(s / 3600).toFixed(1)}時間`;
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export type Family = { root: Agent; all: Agent[] };

export function buildTree(agents: Agent[]) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string, Agent[]>();
  for (const a of agents) {
    if (!a.parent) continue;
    const list = childrenOf.get(a.parent) ?? [];
    list.push(a);
    childrenOf.set(a.parent, list);
  }
  for (const list of childrenOf.values()) list.sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0));
  const collect = (a: Agent): Agent[] => [a, ...(childrenOf.get(a.id) ?? []).flatMap(collect)];
  const families = agents
    .filter((a) => !a.parent)
    .map((root) => ({ root, all: collect(root) }))
    // 世帯の並び順は、親（根）のセッションの開始時刻の順、同じなら ID の順。大きさや状態では並べ替えない（docs/design/household-packing.md）
    .sort((a, b) => (a.root.startedAt ?? 0) - (b.root.startedAt ?? 0) || (a.root.id < b.root.id ? -1 : a.root.id > b.root.id ? 1 : 0));
  const lineage = (a: Agent): Agent[] => {
    const out: Agent[] = [];
    for (let cur: Agent | undefined = a; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) out.unshift(cur);
    return out;
  };
  return { byId, childrenOf, families, lineage };
}

export function projectOf(a: Agent): string {
  return a.cwd.split("/").filter(Boolean).pop() ?? a.cwd;
}

/** 返事の最後の段落が問いで、その中に短い選択肢の行があれば取り出す（ボタンにする） */
export function choicesOf(text: string): string[] {
  const paras = text.trim().split(/\n\s*\n/);
  const tail = paras.slice(-2).join("\n");
  if (!/[?？]/.test(tail)) return [];
  const opts: string[] = [];
  for (const line of tail.split("\n")) {
    const m = line.match(/^\s*(?:[-*・]|\d+[.)．]|[A-DＡ-Ｄ][:：.)])\s*(.+?)\s*$/);
    if (m && m[1].length <= 40) opts.push(m[1].replace(/\*\*/g, ""));
  }
  return opts.length >= 2 && opts.length <= 5 ? opts : [];
}

/**
 * 世帯の名前。本人が画面で付けた名前（by=human）を優先し、無ければ根のセッションの作業ディレクトリの最後の名前。
 * 子の場所、最初の依頼、エージェントが hook で付けた名前（by=agent）は使わない。
 */
export function houseNameOf(root: Agent, _all?: Agent[]): { name: string; by: "human" | "dir" } {
  if (root.house?.by === "human" && root.house.name) return { name: root.house.name, by: "human" };
  return { name: projectOf(root), by: "dir" };
}

/**
 * 送信先として出す名前（#36）。町に同じ名前の人がほかにいるときは、ID の先頭8字を添えて見分けられるようにする。
 * 名前は作業ディレクトリの最後の名前なので、同じディレクトリで立てたセッションどうしは同じ名前になる
 */
export function targetLabel(agent: Agent, town: Agent[]): string {
  const twin = town.some((a) => a.id !== agent.id && a.name === agent.name);
  return twin ? `${agent.name}（${agent.id.slice(0, 8)}）` : agent.name;
}
