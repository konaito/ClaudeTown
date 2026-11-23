import { describe, expect, test } from "bun:test";
import { flightsOf, resolve, resolvePeer, type LetterRec } from "./letters";
import type { Agent } from "./model";
import cases from "./teammate-read-cases.json";

const ag = (id: string, name: string, pid?: number, parent: string | null = null): Agent => ({
  id, name, pid, parent, kind: "terminal", state: "idle", cwd: "/", canSend: true,
});
const OYA = "aaaaaaaa-0000-0000-0000-000000000001";
const KO = "bbbbbbbb-0000-0000-0000-000000000002";
const MAGO = "cccccccc-0000-0000-0000-000000000003";
const town = [ag(OYA, "meta-fc", 63513), ag(KO, "family-computing", 86003, OYA), ag(MAGO, "fc-test", 91000, KO)];

describe("宛先の結び付け", () => {
  test("uds のソケットの pid", () => expect(resolve("uds:/tmp/cc-socks/86003.sock", town)).toBe(KO));
  test("セッション ID の先頭8字と、ノード付きの形", () => {
    expect(resolve("cccccccc", town)).toBe(MAGO);
    expect(resolve(`vm/${KO}`, town)).toBe(KO);
  });
  test("名前と、末尾の [ref]", () => {
    expect(resolve("meta-fc", town)).toBe(OYA);
    expect(resolve("fc-test [3fa9c1]", town)).toBe(MAGO);
  });
  test("名前が2人と一致したら結ばない", () => {
    expect(resolve("dup", [...town, ag("d1", "dup"), ag("d2", "dup")])).toBeNull();
  });
  test("町にいない宛先は結ばない", () => {
    expect(resolve("uds:/tmp/cc-socks/1.sock", town)).toBeNull();
    expect(resolve("main", town)).toBeNull();
  });
});

const sent = (id: string, from: string, to: string, at: number, extra: Partial<LetterRec> = {}): LetterRec =>
  ({ ev: "sent", id, at, kind: "send", from, to, summary: id, ...extra });
const recv = (id: string, to: string, at: number, extra: Partial<LetterRec>): LetterRec =>
  ({ ev: "received", id, at, to, summary: id, ...extra });

describe("飛ばす封筒", () => {
  test("親→子、子→親（報告）、子→孫の3通り", () => {
    const f = flightsOf([
      sent("s1", OYA, "family-computing", 1000),
      sent("s2", KO, "uds:/tmp/cc-socks/63513.sock", 2000),
      sent("s3", KO, "", 3000, { kind: "ccn_create", to_id: MAGO }),
    ], town);
    expect(f.map((x) => [x.from, x.to])).toEqual([[OYA, KO], [KO, OYA], [KO, MAGO]]);
  });

  test("sent と対になる received は2回飛ばさず、読んだ時刻になる", () => {
    const f = flightsOf([
      sent("s1", OYA, "family-computing", 1000),
      recv("r1", KO, 5000, { from_raw: "uds:/tmp/cc-socks/63513.sock", from_name: "meta-fc" }),
    ], town);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: "s1", from: OYA, to: KO, readAt: 5000 });
  });

  test("sent が無い received は、受けた時刻で飛ばす（ccn の from agent 行）", () => {
    const f = flightsOf([recv("r1", MAGO, 7000, { from_node: "konaito-pro", from_sid8: "bbbbbbbb" })], town);
    expect(f).toEqual([{ id: "r1", from: KO, to: MAGO, at: 7000, summary: "r1", readAt: 7000 }]);
  });

  test("同じ相手への2通は、古い順に1通ずつ対にする", () => {
    const f = flightsOf([
      sent("s1", OYA, KO, 1000), sent("s2", OYA, KO, 2000),
      recv("r1", KO, 2500, { from_raw: "uds:/tmp/cc-socks/63513.sock" }),
    ], town);
    expect(f.map((x) => [x.id, x.readAt])).toEqual([["s1", 2500], ["s2", null]]);
  });

  test("結べない宛先、自分あて、町にいない送り手は飛ばさない", () => {
    const f = flightsOf([
      sent("s1", OYA, "main", 1000),
      sent("s2", OYA, OYA, 1000),
      sent("s3", "zzzzzzzz-gone", KO, 1000),
      recv("r1", KO, 1000, { from_raw: "uds:/tmp/cc-socks/1.sock" }),
    ], town);
    expect(f).toEqual([]);
  });
});

describe("会話を開いているセッションを起点にした結び付け（agent teams）", () => {
  const sub = (id: string, name: string, parent: string): Agent => ({ ...ag(id, name, undefined, parent), kind: "subagent" });
  const LEAD = "dddddddd-0000-0000-0000-000000000004";
  const LEAD2 = "eeeeeeee-0000-0000-0000-000000000005";
  const A = sub("sub-accn-removal@dddddddd", "ccn-removal", LEAD);
  const B = sub("sub-aletter-lead-avatar@dddddddd", "letter-lead-avatar", LEAD);
  // 別のチームに同じ名前のチームメイトがいる
  const A2 = sub("sub-accn-removal@eeeeeeee", "ccn-removal", LEAD2);
  const team = [...town, ag(LEAD, "family-computing", 70000), ag(LEAD2, "family-computing", 70001), A, B, A2];
  const leadOf = (id: string) => team.find((a) => a.id === id)!;

  test("teammate:team-lead は、受け取ったチームメイトの親（リード）", () => {
    expect(resolvePeer("teammate:team-lead", "team-lead", A, team)).toBe(LEAD);
    expect(resolvePeer("teammate:team-lead", "team-lead", A2, team)).toBe(LEAD2);
  });

  test("teammate:<名前> は、同じリードの下のチームメイト。リードが受けたときはリードの子から引く", () => {
    expect(resolvePeer("teammate:letter-lead-avatar", "letter-lead-avatar", A, team)).toBe(B.id);
    expect(resolvePeer("teammate:ccn-removal", "ccn-removal", leadOf(LEAD), team)).toBe(A.id);
    expect(resolvePeer("teammate:ccn-removal", "ccn-removal", leadOf(LEAD2), team)).toBe(A2.id);
  });

  test("チームの中にいない teammate は、町の同名に結ばない", () => {
    expect(resolvePeer("teammate:ccn-removal", "ccn-removal", ag("x", "solo", 1), team)).toBeNull();
    expect(resolvePeer("teammate:meta-fc", "meta-fc", A, team)).toBeNull();
    // リードが町にいなければ結ばない
    expect(resolvePeer("teammate:team-lead", "team-lead", sub("s", "orphan", "gone"), team)).toBeNull();
  });

  test("チームメイトを kind: teammate で出す一覧でも引ける", () => {
    const t = (a: Agent) => ({ ...a, kind: "teammate" }) as unknown as Agent;
    const team2 = team.map((a) => (a === A || a === B ? t(a) : a));
    expect(resolvePeer("teammate:team-lead", "team-lead", t(A), team2)).toBe(LEAD);
    expect(resolvePeer("teammate:letter-lead-avatar", "letter-lead-avatar", t(A), team2)).toBe(B.id);
  });

  test("送ったお手紙の宛先: main と team-lead はリード、名前はチームの中から", () => {
    expect(resolvePeer("main", "main", B, team)).toBe(LEAD);
    expect(resolvePeer("team-lead", "team-lead", B, team)).toBe(LEAD);
    expect(resolvePeer("ccn-removal", "ccn-removal", B, team)).toBe(A.id);
    expect(resolvePeer("ccn-removal", "ccn-removal", leadOf(LEAD2), team)).toBe(A2.id);
  });

  test("チームの形でない宛先は、これまでどおり町の一覧から引く", () => {
    expect(resolvePeer("family-computing", "family-computing", ag(OYA, "meta-fc"), town)).toBe(KO);
    expect(resolvePeer("uds:/tmp/cc-socks/86003.sock", "meta-fc", B, team)).toBe(KO);
    expect(resolvePeer("konaito-pro/cccccccc/x", null, B, team)).toBe(MAGO);
    expect(resolvePeer("main", "main", ag(OYA, "meta-fc"), town)).toBeNull();
  });
});

describe("agent teams の送った記録（#271。2026-11-23 に Claude Code 2.1.330 で hook が書いた行）", () => {
  const mate = (id: string, name: string, parent: string): Agent => ({ ...ag(id, name, undefined, parent), kind: "teammate" });
  // in-process: チームメイトの行の id は subagents.rs の sub_id。hook も同じ形で from を書く
  const L1 = "00174599-158c-4749-8898-f7579bbb69b9";
  const BOB1 = "sub-abob-f3b9acc817d74619@00174599";
  // tmux: チームメイトは自分のセッション ID の行（teams.rs）
  const L2 = "3cca167e-7c2a-40ab-9f0a-3aedd36600e0";
  const BOB2 = "20586fac-fe61-4e64-9dc7-85a8a12e7783";
  // 別のチームにも bob がいる
  const OTHER = mate("sub-abob-0000000000000000@ffffffff", "bob", "ffffffff-0000-0000-0000-000000000000");
  const team = [ag(L1, "cwd"), mate(BOB1, "bob", L1), ag(L2, "cwd"), mate(BOB2, "bob", L2), OTHER];

  test("in-process: チームメイト→team-lead と、リード→チームメイト", () => {
    const f = flightsOf([
      sent("f1", BOB1, "team-lead", 1000),
      sent("f2", L1, "bob", 2000),
    ], team);
    expect(f.map((x) => [x.from, x.to])).toEqual([[BOB1, L1], [L1, BOB1]]);
  });

  test("tmux: チームメイト→team-lead と、リード→チームメイト", () => {
    const f = flightsOf([
      sent("f55a54659cec", BOB2, "team-lead", 1795374902248),
      sent("2af50b8ce620", L2, "bob", 1795374905206),
    ], team);
    expect(f.map((x) => [x.from, x.to])).toEqual([[BOB2, L2], [L2, BOB2]]);
  });
});

describe("受けた側の jsonl の teammate-message で既読にする（#276。src/teammate-read-cases.json を Rust の native/received.rs と同じに読む）", () => {
  const c = cases as unknown as { agents: Agent[]; sent: LetterRec[]; received: LetterRec[]; readAt: Record<string, number | null> };

  test("sent と、受けた側の jsonl から作った received を対にして、readAt を付ける", () => {
    const f = flightsOf([...c.sent, ...c.received], c.agents);
    expect(Object.fromEntries(f.map((x) => [x.id, x.readAt]))).toEqual(c.readAt);
  });

  test("対になる sent の無い jsonl の received（idle_notification など）は、封筒にしない", () => {
    const f = flightsOf(c.received, c.agents);
    expect(f).toEqual([]);
  });

  test("hook の received が先に対を取ったら、jsonl の received は余って捨てる（二重に既読にしない）", () => {
    const [L, BOB] = [c.agents[0].id, c.agents[1].id];
    const hook = recv("h1", BOB, 1795395600800, { from_raw: L });
    const f = flightsOf([c.sent[0], hook, c.received[0]], c.agents);
    expect(f.map((x) => [x.id, x.readAt])).toEqual([["s1", 1795395600800]]);
  });
});
