import { describe, expect, test } from "bun:test";
import { connectTerminal } from "./connect";

// 呼ばれたことを残す受け手
const recorder = () => {
  const opened: (() => void)[] = [];
  const failed: string[] = [];
  return { opened, failed, h: { onOpen: (c: () => void) => { opened.push(c); }, onFail: (m: string) => { failed.push(m); } } };
};

describe("ターミナルを開く結果の受け方（#185）", () => {
  test("開けたら、切断の関数を渡す", async () => {
    const r = recorder();
    const close = () => {};
    await connectTerminal(() => Promise.resolve(close), () => false, r.h);
    expect(r.opened).toEqual([close]);
    expect(r.failed).toEqual([]);
  });

  test("開けた時にはもう閉じていたら、すぐ切って画面には渡さない", async () => {
    const r = recorder();
    let closedCalls = 0;
    await connectTerminal(() => Promise.resolve(() => { closedCalls++; }), () => true, r.h);
    expect(closedCalls).toBe(1);
    expect(r.opened).toEqual([]);
  });

  test("断られたら、理由を onFail に渡し、拒否を外に漏らさない", async () => {
    const r = recorder();
    // Rust の term_open は Err(String) を返し、invoke は文字列で拒否する
    await connectTerminal(() => Promise.reject("このアプリが立てたセッションではない"), () => false, r.h);
    expect(r.failed).toEqual(["ターミナルを開けなかった: このアプリが立てたセッションではない"]);
    expect(r.opened).toEqual([]);
  });

  test("断られた時にはもう別のセッションに移っていたら、何も伝えない", async () => {
    const r = recorder();
    await connectTerminal(() => Promise.reject("断った"), () => true, r.h);
    expect(r.failed).toEqual([]);
    expect(r.opened).toEqual([]);
  });
});
