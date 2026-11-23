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
  /** terminal は対話の claude（このアプリが立てたものと、端末で起動したもの）。subagent は sub-agent、teammate は agent team のチームメイト。
   *  どちらも Claude Code の記録から読み、親のセッションの子として出す。pty と node はブラウザ版（PWA）が ccn から読むセッションの種類 */
  kind: "terminal" | "node" | "pty" | "subagent" | "teammate";
  /** 一覧の出どころ。app はこのアプリが立てた端末で、送信、停止、端末ができる。native は Claude Code の記録（~/.claude）から読んでいるだけで、
   *  capabilities が全部 false。ccn はブラウザ版（PWA）だけが持つ、ccn の一覧の行 */
  source?: "app" | "native" | "ccn";
  /** アプリが立てた端末で、claude がまだ入力を受け付けるところまで起動していない（信頼の確認の画面を含む）。Rust の town_rows が付ける */
  booting?: boolean;
  state: "running" | "waiting_permission" | "idle";
  cwd: string;
  /** cwd のプロジェクトの名前（worktree なら本体の名前。Rust が .git を読んで出す）。モックと古い一覧には無い */
  project?: string | null;
  pid?: number;
  startedAt?: number;
  /** 最後に動きを見た時刻（ms） */
  lastActivityAt?: number;
  canSend: boolean;
  parent: string | null;
  capabilities?: { send?: boolean; permissions?: boolean; interrupt?: boolean; stop?: boolean; terminal?: boolean } | null;
  report?: Report | null;
  closeCheck?: { status: "working" | "checking" | "ok" | "ng" | "error"; short?: string | null } | null;
  /** キャラの絵（Rust が町の中で被らないように割り当てる）。hue は色相のずらし（度） */
  avatar?: { char: string; hue: number } | null;
  /** このセッションの claude が動いているアカウント（cam のコマンド名と email）。ブラウザ版（PWA）が ccn から読む行にだけある */
  account?: string | null;
  accountEmail?: string | null;
};

/** アカウントの表示（「名前（email）」）。email が無ければ名前だけ。アカウントが分からなければ null */
export function accountText(a: Agent): string | null {
  if (!a.account) return null;
  return a.accountEmail ? `${a.account}（${a.accountEmail}）` : a.account;
}

export type Snapshot = {
  agents: Agent[];
  /** お手紙の最近の記録（src/letters.ts） */
  letters?: import("./letters").LetterRec[];
  fetched_at: number;
  /** 一覧の出どころの件数。native は src-tauri/src/native/mod.rs の Stats、app はこのアプリが立てた端末の数 */
  sources?: { native: Record<string, unknown>; app: number } | null;
};

export type ConvItem = {
  /** result は道具の結果（画面は道具の行に付け直し、吹き出しにしない）。event は止めた・失敗したターンの印（#83） */
  role: "user" | "assistant" | "tool" | "result" | "event"; text: string; from?: string | null; at?: string | number | null; pending?: boolean;
  /** 作業中に打たれて、まだ読まれていない文（順番待ち）。conversation の live.queued から画面が付ける */
  queued?: boolean;
  /** claude の起動を待って、まだ送っていない文（Rust の composer.rs が預かっている）。起動したら送る */
  waitBoot?: boolean;
  /** 通し番号（このセッションで何件目か。Rust の conversation が付ける）。吹き出しの key に使う。送ったばかりの仮の項目には無い */
  n?: number;
  /** 別のセッションからのお手紙なら、送り手（from-name と、uds のソケットか agent:<ノード>/<sid8>/<役割>） */
  letter?: { fromName?: string | null; fromRaw?: string | null } | null;
  /** 送ったお手紙（role が tool のとき）。宛先は生のまま。create は子を作って最初の文を渡したもの */
  sent?: { to?: string | null; peer?: string | null; summary?: string; text?: string | null; create?: boolean } | null;
  /** 計画の確認（ExitPlanMode）の本文（role が tool のとき）。承認の欄で、hook の入力が空のときに出す */
  plan?: string;
  /** 道具の呼び出しの id（tool_use の id）。role が result のときは、どの道具の結果か */
  id?: string | null;
  /** 道具の結果（role が tool のとき）。届いていなければ無い */
  result?: { text: string; error: boolean };
  /** role が result のとき、結果が失敗か */
  error?: boolean;
  /** role が event のときの種類。command は、チャットからコマンドを実行した印（画面だけで出す、#97） */
  kind?: "interrupted" | "error" | "command";
};

/**
 * キャラの様子。
 * approval=承認待ち（ペインで答える）、reply=返事待ち（ここから答えられる）、working=作業中、done=完了、idle=待機
 */
export type Mood = "approval" | "reply" | "working" | "done" | "idle";

/**
 * 承認の画面が、hook に何も届かないまま閉じられた（#180）。理由なしの No と Esc では、PermissionRequest と
 * Notification の後に PostToolUse も PostToolUseFailure も Stop も来ず、状態ファイルは needs_you のまま残る
 * （2026-11-23 に Claude Code 2.1.330 で実測）。sessions の status は画面が出ている間 waiting で、閉じると idle に変わる。
 * そこで、承認が元の needs_you（並びが1件以上。Stop の問いかけは並びを空にする）の後に status が変わっていたら、もう待っていない。
 * status を sessions/<pid>.json から読む terminal の行だけに当てる。tmux のチームメイトの state は jsonl の更新時刻から作るので外す。
 * 休んだリードの端末にチームメイトの承認が出たとき、リードの status が変わるかは測っていない。変わらなければ lastActivityAt は
 * 報告より古いままなので、返事待ちのまま残る
 */
function askClosed(a: Agent): boolean {
  const r = a.report;
  if (a.kind !== "terminal" || !r || !((r.pending_count ?? 0) > 0)) return false;
  return a.lastActivityAt != null && r.updated_at != null && a.lastActivityAt > r.updated_at;
}

export function moodOf(a: Agent): Mood {
  if (a.state === "waiting_permission") return "approval";
  if (a.state === "running") return "working";
  if (a.report?.phase === "needs_you" && !askClosed(a)) return "reply";
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

/** 様子の札の文。起動中は様子に関係なく「起動中」と出す（起動の前は sessions/<pid>.json が無く、様子は待機になる） */
export function statusLabel(a: Pick<Agent, "booting">, mood: Mood): string {
  return a.booting ? "起動中" : MOOD_LABEL[mood];
}

/** 様子の札の class。起動中は点を回る輪にする（App.css の .st-boot） */
export function statusClass(a: Pick<Agent, "booting">, mood: Mood): string {
  return `st st-${mood}${a.booting ? " st-boot" : ""}`;
}

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

// ---------- 名前 ----------
// カードと世帯の名前は、そのセッションが作業しているプロジェクトの名前にする。
// 同じ規則を src-tauri/src/naming.rs にも書いてある。試験の事例は src/naming-cases.json にまとめ、両方で読む。
// .git を読んで worktree の本体を出すのは Rust だけ（Agent.project）。ここではパスの形だけで決める。

const segs = (p: string) => p.split("/").filter(Boolean);

/** パスの形だけで出すプロジェクトの名前。`<名前>.wt/<x>` なら <名前>、それ以外は最後の名前 */
export function projectFromPath(cwd: string): string | null {
  const s = segs(cwd);
  if (s.length >= 2) {
    const m = s[s.length - 2].match(/^(.+)\.wt$/);
    if (m) return m[1];
  }
  return s.length ? s[s.length - 1] : null;
}

/**
 * from 行の呼び手 "agent:<ノード>/<sid8>/<役割>" の sid8。Rust の agent_sid8（src-tauri/src/lib.rs）と、
 * claude-code-nodes の identity/agent-name.ts の parseAgent と同じ規則で、2つ目の区切りが16進の8文字で、後ろに役割があるときだけ返す。
 * ccn は session id が分からないと "agent:<ノード>/<役割>" を付けるので、役割を sid8 として読むと、たまたま前が合う id を親にしてしまう
 */
export function agentSid8(caller: unknown): string | null {
  const m = typeof caller === "string" ? caller.match(/^agent:([^/]+)\/([0-9a-f]{8})\/(.+)$/) : null;
  return m ? m[2] : null;
}

/** from 行の呼び手から、生きているセッションの中の親の id を引く。見つからなければ null */
export function parentOfCaller(caller: unknown, ids: string[]): string | null {
  const sid8 = agentSid8(caller);
  return sid8 ? ids.find((id) => id.startsWith(sid8)) ?? null : null;
}

/** 名前を決めるのに使う、1つのセッションの材料（Rust の naming::Who と同じ） */
export type Who = {
  id: string;
  cwd?: string | null;
  title?: string | null;
  /** cwd のプロジェクトの名前（Rust が .git を読んで出す）。無ければパスの形で出す */
  project?: string | null;
};

/**
 * カードの名前を全員分決める。世帯の名前は根のカードの名前なので、親のプロジェクトの名前になる。
 * 1. cwd が無ければセッションの題名、それも無ければ ID の先頭8字
 * 2. cwd があれば、cwd のプロジェクトの名前（worktree は本体の名前。~/Documents 直下、ホーム、/tmp なども cwd の最後の名前）。
 *    子孫の cwd や、エージェントが付けた名前（houses.json）は見ない
 */
export function cardNames(ws: Who[]): Map<string, string> {
  return new Map(
    ws.map((w) => [w.id, !w.cwd ? w.title || w.id.slice(0, 8) : w.project || projectFromPath(w.cwd) || "/"] as [string, string]),
  );
}

/**
 * 返事の最後の問いに付いた選択肢の行を取り出す（ボタンにする）。選択肢は、問いの行のすぐ後ろ（無ければ、選ぶ言い方の問いに限ってすぐ前）に続く箇条書き。
 * - と * は後ろに空白があるときだけ箇条書きとみる（「**太字**」の行を箇条書きにしない、2026-11-22）
 * 長すぎる行が混じったら、黙って落とさずに何も出さない（落とすと残りだけの違う選択肢になる、2026-11-22）
 */
export function choicesOf(text: string): string[] {
  const lines = text.trim().split("\n").slice(-40);
  const item = (line: string): string | null => {
    const m = line.match(/^\s*(?:[-*]\s+|・\s*|\d+[.)．]\s*|[A-DＡ-Ｄ][:：.)]\s*)(.+?)\s*$/);
    return m ? m[1].replace(/\*\*/g, "").trim() : null;
  };
  let q = -1;
  lines.forEach((l, i) => { if (/[?？]/.test(l) && item(l) === null) q = i; });
  if (q < 0) return [];
  // 問いの後ろの段落か前の段落。間の空行は1つまで
  const block = (from: number, step: 1 | -1): string[] => {
    const out: string[] = [];
    let i = from;
    if (lines[i] !== undefined && !lines[i].trim()) i += step;
    for (; i >= 0 && i < lines.length; i += step) {
      const it = item(lines[i]);
      if (it === null) break;
      out.push(it);
    }
    return step === 1 ? out : out.reverse();
  };
  const after = block(q + 1, 1);
  // 前の箇条書きは、問いが「どれ」「どっち」のように選ぶ言い方のときだけ選択肢にする。はい/いいえの問いの前の箇条書きは報告の一部（2026-11-22）
  const opts = after.length ? after : /どれ|どっち|どちら|どの|選[んべぶ]/.test(lines[q]) ? block(q - 1, -1) : [];
  if (opts.some((o) => !o || o.length > 200)) return [];
  return opts.length >= 2 && opts.length <= 5 ? opts : [];
}

/** 世帯の名前。根のカードの名前（cardNames と同じ決め方。Rust の snapshot が name に入れてある）。保存された名前は見ない */
export function houseNameOf(root: Agent): string {
  return root.name;
}

/**
 * 送信先として出す名前（#36）。町に同じ名前の人がほかにいるときは、ID の先頭8字を添えて見分けられるようにする。
 * 名前は作業ディレクトリの最後の名前なので、同じディレクトリで立てたセッションどうしは同じ名前になる
 */
export function targetLabel(agent: Agent, town: Agent[]): string {
  const twin = town.some((a) => a.id !== agent.id && a.name === agent.name);
  return twin ? `${agent.name}（${agent.id.slice(0, 8)}）` : agent.name;
}
