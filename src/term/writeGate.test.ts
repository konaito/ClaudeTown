import { describe, expect, test } from "bun:test";
import { createWriteGate } from "./writeGate";

// 偽の write。書いた文字列と完了の関数を残し、finish() で完了を呼ぶ
const fake = () => {
  const writes: string[] = [];
  const dones: (() => void)[] = [];
  return { writes, finish: () => dones.splice(0).forEach((d) => d()), write: (s: string, d: () => void) => { writes.push(s); dones.push(d); } };
};

describe("書き込みをためる（#8）", () => {
  test("見えている間は、そのまま書く", () => {
    const f = fake();
    const g = createWriteGate(f.write, true);
    g.push("a"); g.push("b");
    expect(f.writes).toEqual(["a", "b"]);
  });

  test("隠れている間は書かず、見えたら順番どおり1回で書く", () => {
    const f = fake();
    const g = createWriteGate(f.write, false);
    g.push("a"); g.push("b"); g.push("c");
    expect(f.writes).toEqual([]);
    expect(g.pending()).toBe(3);
    g.setOpen(true);
    expect(f.writes).toEqual(["abc"]);
    expect(g.pending()).toBe(0);
  });

  test("完了の関数は、まとめた write が終わったあとに順に呼ぶ", () => {
    const f = fake();
    const g = createWriteGate(f.write, false);
    const order: string[] = [];
    g.push("a", () => order.push("a")); g.push("b", () => order.push("b"));
    g.setOpen(true);
    expect(order).toEqual([]);
    f.finish();
    expect(order).toEqual(["a", "b"]);
  });

  test("ためたものが無ければ、見えても書かない。同じ状態への切り替えは何もしない", () => {
    const f = fake();
    const g = createWriteGate(f.write, false);
    g.setOpen(true); g.setOpen(true);
    expect(f.writes).toEqual([]);
  });

  test("見えたあとにまた隠れたら、またためる", () => {
    const f = fake();
    const g = createWriteGate(f.write, true);
    g.push("a");
    g.setOpen(false);
    g.push("b"); g.push("c");
    g.setOpen(true);
    expect(f.writes).toEqual(["a", "bc"]);
  });

  test("drop は、ためた分を書かずに捨て、完了の関数だけ呼ぶ", () => {
    const f = fake();
    const g = createWriteGate(f.write, false);
    let n = 0;
    g.push("a", () => n++); g.push("b", () => n++);
    g.drop();
    expect(n).toBe(2);
    g.setOpen(true);
    expect(f.writes).toEqual([]);
  });

  test("上限を超えたら、隠れていても書く（捨てない）", () => {
    const f = fake();
    const g = createWriteGate(f.write, false, 5);
    g.push("abc"); expect(f.writes).toEqual([]);
    g.push("def"); expect(f.writes).toEqual(["abcdef"]);
    g.push("g"); g.setOpen(true);
    expect(f.writes).toEqual(["abcdef", "g"]);
  });
});
