import { describe, expect, test } from "bun:test";
import { collectMail, orderMail, type Mail } from "./mail";
import type { Agent } from "./model";

const ag = (id: string, o: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: "node", state: "idle", cwd: "/", canSend: true, parent: null, ...o,
});
const approval = (id: string, at: number, parent: string | null = null) =>
  ag(id, { state: "waiting_permission", parent, lastActivityAt: at });
const reply = (id: string, at: number, parent: string | null = null) =>
  ag(id, { parent, report: { phase: "needs_you", updated_at: at } });

const ids = (m: Mail[]) => m.map((x) => `${x.town}/${x.agent.id}`);

describe("お便りの並び", () => {
  test("親は、子より新しくても子より先に来る", () => {
    const m = collectMail([{ town: "pro", agents: [ag("p"), approval("c", 100, "p"), reply("p2", 900)] }]);
    expect(ids(m)).toEqual(["pro/p2", "pro/c"]);
  });

  test("町をまたいでも親が先、その中は待ち始めが古い順", () => {
    const m = collectMail([
      { town: "pro", agents: [reply("pa", 500), ag("pb"), approval("pb-kid", 10, "pb")] },
      { town: "vm", agents: [approval("va", 300), ag("vb"), reply("vb-kid", 20, "vb"), ag("vb-g", { parent: "vb-kid", state: "waiting_permission", lastActivityAt: 5 })] },
    ]);
    expect(ids(m)).toEqual(["vm/va", "pro/pa", "vm/vb-g", "pro/pb-kid", "vm/vb-kid"]);
  });

  test("親が子より後に来ない（ランダムな町と時刻で 500 回）", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let k = 0; k < 500; k++) {
      const towns = ["pro", "vm", "inc"].map((town) => {
        const agents: Agent[] = [];
        for (let i = 0; i < 6; i++) {
          const parent = i > 0 && rnd() < 0.6 ? `${town}${Math.floor(rnd() * i)}` : null;
          const at = Math.floor(rnd() * 1000);
          agents.push(rnd() < 0.5 ? approval(`${town}${i}`, at, parent) : reply(`${town}${i}`, at, parent));
        }
        return { town, agents };
      });
      const m = collectMail(towns);
      const firstKid = m.findIndex((x) => !x.root);
      if (firstKid >= 0) expect(m.slice(firstKid).every((x) => !x.root)).toBe(true);
      for (let i = 1; i < m.length; i++) {
        if (m[i - 1].root === m[i].root) expect(m[i - 1].since <= m[i].since).toBe(true);
      }
    }
  });

  test("承認待ちか返事待ちかでは並べ替えない", () => {
    const m = collectMail([{ town: "pro", agents: [reply("old", 1), approval("new", 2)] }]);
    expect(ids(m)).toEqual(["pro/old", "pro/new"]);
  });

  test("親が一覧にいなければ根として扱う", () => {
    const m = collectMail([{ town: "vm", agents: [reply("orphan", 50, "gone"), approval("root", 60)] }]);
    expect(m.map((x) => [x.agent.id, x.root])).toEqual([["orphan", true], ["root", true]]);
  });

  test("時刻が分からないものは同じ組の最後、同じ時刻は町と ID の順", () => {
    const m = orderMail(collectMail([
      { town: "vm", agents: [ag("x", { state: "waiting_permission" }), approval("b", 7)] },
      { town: "pro", agents: [approval("a", 7)] },
    ]));
    expect(ids(m)).toEqual(["pro/a", "vm/b", "vm/x"]);
  });

  test("作業中と待機はお便りにしない", () => {
    const m = collectMail([{ town: "pro", agents: [ag("w", { state: "running" }), ag("i")] }]);
    expect(m).toEqual([]);
  });
});
