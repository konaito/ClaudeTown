import { describe, expect, test } from "bun:test";
import { deltaOf, mergeConv, KEEP_CONV, savedLabel, elapsedText, liveSummary, sameLive, settlePending, type Live, type PendingItem } from "./conv";
import type { ConvItem } from "./model";

const item = (n: number): ConvItem => ({ role: "assistant", text: `t${n}`, n });

describe("mergeConv", () => {
  test("増えていなければ同じ配列を返す（描き直さない）", () => {
    const prev = [item(0), item(1)];
    expect(mergeConv(prev, { items: [], total: 2, reset: false })).toBe(prev);
  });
  test("増えた分を後ろに足し、上限を超えた分は前から捨てる", () => {
    const prev = Array.from({ length: KEEP_CONV }, (_, i) => item(i));
    const next = mergeConv(prev, { items: [item(KEEP_CONV)], total: KEEP_CONV + 1, reset: false });
    expect(next.length).toBe(KEEP_CONV);
    expect(next[0].n).toBe(1);
    expect(next[KEEP_CONV - 1].n).toBe(KEEP_CONV);
    // 前からある項目は同じもの（吹き出しの memo が効く）
    expect(next[0]).toBe(prev[1]);
  });
  test("同じ差分が2回届いても足すのは1回", () => {
    const d = { items: [item(2)], total: 3, reset: false };
    const once = mergeConv([item(0), item(1)], d);
    expect(mergeConv(once, d)).toBe(once);
    expect(once.map((x) => x.n)).toEqual([0, 1, 2]);
  });
  test("reset なら置き換える", () => {
    const next = mergeConv([item(0)], { items: [item(5), item(6)], total: 7, reset: true });
    expect(next.map((x) => x.n)).toEqual([5, 6]);
  });
});

describe("deltaOf", () => {
  const all: ConvItem[] = Array.from({ length: 100 }, (_, i) => ({ role: "user", text: `u${i}` }));
  test("初めては最後の上限分を reset で", () => {
    const d = deltaOf(all, null);
    expect(d.reset).toBe(true);
    expect(d.items.length).toBe(KEEP_CONV);
    expect(d.items[0].n).toBe(100 - KEEP_CONV);
    expect(d.total).toBe(100);
  });
  test("持っている分のあとだけ", () => {
    expect(deltaOf(all, 100).items).toEqual([]);
    expect(deltaOf(all, 98).items.map((x) => x.n)).toEqual([98, 99]);
  });
});

test("保存した時刻は、今日なら時刻だけ、別の日なら日付も付ける", () => {
  const at = new Date(2026, 10, 13, 9, 5).getTime();
  expect(savedLabel(at, new Date(2026, 10, 13, 23, 0).getTime())).toBe("09:05");
  expect(savedLabel(at, new Date(2026, 10, 14, 0, 1).getTime())).toBe("11/13 09:05");
});

describe("今の動き（#59）", () => {
  const base: Live = { tools: [], last: "result", last_at: "2026-11-13T07:00:00.000Z", turn_at: 1000 };
  test("道具が無ければ考え中で、最後の出来事から数える", () => {
    expect(liveSummary(base)).toEqual({ label: "考え中", heads: [], since: Date.parse("2026-11-13T07:00:00.000Z") });
  });
  test("考え中は、ターンの始まりより前からは数えない", () => {
    expect(liveSummary({ ...base, last: "text", last_at: 100, turn_at: 5000 }).since).toBe(5000);
  });
  test("道具が1つならその中身、複数なら種類ごとの件数と新しい順の頭", () => {
    const one = { ...base, tools: [{ id: "a", kind: "シェル", text: "コマンド: git status", at: 5 }] };
    expect(liveSummary(one)).toEqual({ label: "コマンド: git status", heads: [], since: 5 });
    const many = { ...base, tools: [
      { id: "a", kind: "シェル", text: "コマンド: a", at: 5 },
      { id: "b", kind: "ccn", text: "send_message: x", at: 6 },
      { id: "c", kind: "シェル", text: "コマンド: c", at: 7 },
      { id: "d", kind: "ccn", text: "send_message: y", at: 8 },
    ] };
    expect(liveSummary(many)).toEqual({ label: "シェル2件・ccn 2件を実行中", heads: ["send_message: y", "コマンド: c", "send_message: x"], since: 5 });
  });
  test("経過の書き方", () => {
    expect(elapsedText(-5)).toBe("0秒");
    expect(elapsedText(22_400)).toBe("22秒");
    expect(elapsedText(65_000)).toBe("1分5秒");
    expect(elapsedText(3_720_000)).toBe("1時間2分");
  });
  test("中身が同じなら同じとみなす", () => {
    expect(sameLive(base, { ...base })).toBe(true);
    expect(sameLive(base, { ...base, last: "tool" })).toBe(false);
    expect(sameLive(null, undefined)).toBe(true);
  });
});

describe("settlePending（#69）", () => {
  const u = (n: number, text: string): ConvItem => ({ role: "user", text, n });
  const p = (text: string, after: number): PendingItem => ({ role: "user", text, pending: true, after });
  test("会話に出た文の仮の項目を消す。出ていなければ同じ配列", () => {
    const pend = [p("一通目", 4)];
    expect(settlePending([u(3, "前"), item(4)], pend)).toBe(pend);
    expect(settlePending([item(4), u(5, "一通目")], pend)).toEqual([]);
  });
  test("改行や行末の空白の違いは同じ文とみなす", () => {
    expect(settlePending([u(5, "/a/b.png \n\nこれ見て")], [p("/a/b.png\nこれ見て ", 4)])).toEqual([]);
  });
  test("画像のパスが会話で [Image #3] になっていても同じ文とみなす", () => {
    const sent = "/Users/me/.family-computing/attachments/drop-20261114-054022-9dae-スクリーンショット-2026-11-14-14.50.00.png \n（ドロップの確認）見て";
    expect(settlePending([u(5, "[Image #3]\n（ドロップの確認）見て")], [p(sent, 4)])).toEqual([]);
    // 読めなかったパスはそのまま残る（2026-11-14 の meta）
    const tmp = "/var/folders/lp/x/T/TemporaryItems/NSIRD_screencaptureui_GJ7Y9w/スクリーンショット\\ 2026-11-14\\ 14.20.54.png \n\nこれ挙動がおかしいぞ";
    expect(settlePending([u(5, tmp)], [p(tmp, 4)])).toEqual([]);
    // パスだけが違う文は同じとみなすが、本文が違えば消さない
    const pend = [p("/a/b.png\nこれ見て", 4)];
    expect(settlePending([u(5, "[Image #1]\nあれ見て")], pend)).toBe(pend);
  });
  test("送り始める前の同じ文では消さない", () => {
    const pend = [p("はい", 5)];
    expect(settlePending([u(5, "はい")], pend)).toBe(pend);
  });
  test("同じ文を2回送ったら、会話に出た数だけ消す", () => {
    const pend = [p("はい", 4), p("はい", 4)];
    expect(settlePending([u(5, "はい")], pend)).toEqual([pend[1]]);
  });
  test("後に送った文が出たら、前に送った仮の項目も消す（後の文より下に残さない）", () => {
    // 1通目は会話では形が変わって突き合わせられない（[Image #1] にされたなど）、2通目は出た、3通目はまだ
    const pend = [p("/tmp/a.png これ見て", 4), p("先に送ったやつ", 4), p("三通目", 4)];
    const items = [item(4), u(5, "[Image #1] これ見て"), item(6), u(7, "先に送ったやつ")];
    expect(settlePending(items, pend)).toEqual([pend[2]]);
  });
});
