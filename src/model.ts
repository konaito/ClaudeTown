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
  canSend: boolean;
  parent: string | null;
  depth?: number | null;
  title?: string | null;
  terminalId?: string | null;
  selfStatus?: { state: string; note: string; at: string } | null;
  report?: Report | null;
  closeCheck?: { status: "working" | "checking" | "ok" | "ng" | "error"; short?: string | null } | null;
  /** 家の名前（根のセッションだけ意味がある）。by=human は本人がアプリで付けた名前 */
  house?: { name: string; by: "agent" | "human" } | null;
};

export type Snapshot = {
  ccn: string;
  peer: string | null;
  ccn_ok: boolean;
  ccn_error: string | null;
  agents: Agent[];
  fetched_at: number;
};

export type Peer = { name: string; url: string; status: string; self: boolean };

export type ConvItem = { role: "user" | "assistant" | "tool"; text: string; from?: string | null; at?: string | null; pending?: boolean };

/**
 * キャラの様子。
 * approval=承認待ち（ペインで答える）、reply=返事待ち（ここから答えられる）、working=作業中、done=完了、idle=待機
 */
export type Mood = "approval" | "reply" | "working" | "done" | "idle";

export function moodOf(a: Agent): Mood {
  if (a.state === "waiting_permission") return "approval";
  if (a.state === "running") return "working";
  if (a.report?.phase === "needs_you") return "reply";
  if (a.selfStatus?.state === "blocked") return "reply";
  if (a.closeCheck?.status === "ok" || a.selfStatus?.state === "done") return "done";
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
  if (mood === "reply") return r?.next ?? r?.needs ?? a.selfStatus?.note ?? "返事を待っています";
  if (mood === "done") return "完了";
  const t = a.title && !a.title.startsWith("（") ? a.title : null;
  return t ?? r?.asked ?? (a.parent ? "おてつだい" : "全体をまとめる");
}

/** いまの様子の1行（作業中なら道具、待機なら理由） */
export function nowOf(a: Agent, mood: Mood): string | null {
  const r = a.report;
  switch (mood) {
    case "approval": return r?.needs ?? r?.doing ?? null;
    case "reply": return r?.said ?? r?.needs ?? null;
    case "working": return r?.doing ?? a.selfStatus?.note ?? null;
    case "done": return r?.said ?? a.selfStatus?.note ?? null;
    case "idle": return a.selfStatus?.note ?? a.closeCheck?.short ?? r?.said ?? null;
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
  const rank = (f: Family) => {
    const moods = f.all.map(moodOf);
    return moods.some((m) => NEEDS_YOU.includes(m)) ? 0 : moods.includes("working") ? 1 : 2;
  };
  const families = agents
    .filter((a) => !a.parent)
    .map((root) => ({ root, all: collect(root) }))
    .sort((a, b) => rank(a) - rank(b) || (b.all.length - a.all.length));
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
 * 家の名前。本人が付けた名前 > 親が付けた名前 > 仮の名前。
 * 仮の名前は、子や孫の作業場所で一番多いディレクトリ名（親の場所は meta などで共通なので除く）。無ければ最初の依頼の先頭。
 */
export function houseNameOf(root: Agent, all: Agent[]): { name: string; by: "human" | "agent" | "guess" } {
  if (root.house?.name) return { name: root.house.name, by: root.house.by };
  const rootDir = projectOf(root);
  const count = new Map<string, number>();
  for (const a of all) {
    if (a.id === root.id) continue;
    const d = projectOf(a);
    if (d === rootDir) continue;
    count.set(d, (count.get(d) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (top) return { name: top, by: "guess" };
  const asked = root.report?.asked?.trim();
  if (asked) return { name: clip(asked, 12), by: "guess" };
  return { name: rootDir, by: "guess" };
}
