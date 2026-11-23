import { describe, expect, test } from "bun:test";
import { closedDescendants, killPlan } from "./killPlan";
import { buildTree, type Agent } from "./model";
import { NEW_HOUSE_CAPS, NO_CAPS } from "./abilities";

const app = { send: true, permissions: true, interrupt: true, stop: true, terminal: true };
const ag = (id: string, parent: string | null, over: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: "terminal", state: "idle", cwd: "/p", canSend: true, parent, capabilities: app, ...over,
});
// Rust の subagents.rs の行（pid は null、capabilities は read_only_caps）。型は pid?: number だが、実物は JSON の null で届く
const sub = (id: string, parent: string, over: Partial<Agent> = {}): Agent =>
  ag(id, parent, { kind: "subagent", canSend: false, capabilities: NO_CAPS, pid: null as unknown as number, ...over });
// in-process のチームメイト（subagents.rs が kind teammate、pid null で出す）
const inproc = (id: string, parent: string) => sub(id, parent, { kind: "teammate" });
// tmux のチームメイト（teams.rs が kind teammate、pid ありで出す）
const tmux = (id: string, parent: string) => sub(id, parent, { kind: "teammate", pid: 4242 });
// 外で起動した端末の claude（sessions.rs の行）
const outside = (id: string, parent: string) => ag(id, parent, { capabilities: NO_CAPS, canSend: false, pid: 777 });

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const plan = (agents: Agent[], root = "root") => {
  const t = buildTree(agents);
  return killPlan(t.childrenOf, t.byId.get(root)!);
};

describe("killPlan（#183）", () => {
  test("sub-agent を持つ親を閉じても、sub-agent は残す分に入らず、親と一緒に終わる", () => {
    const p = plan([ag("root", null), sub("explore", "root")]);
    expect(ids(p.keep)).toEqual([]);
    expect(ids(p.stop)).toEqual(["root"]);
    expect(p.descendants).toBe(1);
  });

  test("in-process のチームメイトと、sub-agent の sub-agent も親と一緒に終わる", () => {
    const p = plan([ag("root", null), inproc("mate", "root"), sub("s1", "root"), sub("s2", "s1")]);
    expect(ids(p.keep)).toEqual([]);
    expect(p.descendants).toBe(3);
  });

  test("tmux のチームメイトは別のプロセスなので、止められず残す分に入る。子孫の人数に数えない", () => {
    const p = plan([ag("root", null), tmux("mate", "root")]);
    expect(ids(p.keep)).toEqual(["mate"]);
    expect(p.descendants).toBe(0);
  });

  test("外で起動した子は残す分に入り、その sub-agent は名前を出さず、閉じた人数にも数えない", () => {
    const p = plan([ag("root", null), ag("kid", "root"), outside("ext", "root"), sub("ext-sub", "ext"), sub("kid-sub", "kid")]);
    expect(ids(p.stop)).toEqual(["kid", "root"]);
    expect(ids(p.keep)).toEqual(["ext"]);
    expect(p.descendants).toBe(2);
  });

  test("止める順は葉から", () => {
    const p = plan([ag("root", null), ag("a", "root", { startedAt: 1 }), ag("b", "a"), ag("c", "root", { startedAt: 2 })]);
    expect(ids(p.stop)).toEqual(["b", "a", "c", "root"]);
  });

  test("アプリが立てたばかりで仮の capabilities の子も止める", () => {
    const p = plan([ag("root", null), ag("new", "root", { capabilities: NEW_HOUSE_CAPS })]);
    expect(ids(p.stop)).toEqual(["new", "root"]);
  });

  test("止まらなかった子の sub-agent は、閉じた人数に数えない", () => {
    const agents = [ag("root", null), ag("kid", "root"), sub("kid-sub", "kid"), sub("root-sub", "root")];
    const t = buildTree(agents);
    const root = t.byId.get("root")!;
    const p = killPlan(t.childrenOf, root);
    expect(p.descendants).toBe(3);
    // kid が止まらず、root だけ止まった
    expect(closedDescendants(root, p.ride, [root])).toBe(1);
  });
});
