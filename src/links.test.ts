import { describe, expect, test } from "bun:test";
import { TERM_URL_RE, safeUrl, splitLinks } from "./links";

const urls = (s: string) => splitLinks(s).filter((p) => p.url).map((p) => p.text);

describe("splitLinks", () => {
  test("直後の日本語と句読点を URL に含めない", () => {
    expect(urls("PR: https://github.com/konaito/ClaudeTown/pull/35を見て。")).toEqual(["https://github.com/konaito/ClaudeTown/pull/35"]);
    expect(urls("本番 https://ccn.fybe.jp、確認")).toEqual(["https://ccn.fybe.jp"]);
    expect(urls("（https://example.com/a?b=1）")).toEqual(["https://example.com/a?b=1"]);
  });
  test("文末の記号を外す", () => {
    expect(urls("see https://example.com/x.")).toEqual(["https://example.com/x"]);
    expect(urls("(see https://example.com/x)")).toEqual(["https://example.com/x"]);
    expect(urls("ここ: https://example.com/x!?")).toEqual(["https://example.com/x"]);
  });
  test("対になる括弧、クエリ、フラグメント、ポートは残す", () => {
    expect(urls("https://en.wikipedia.org/wiki/Foo_(bar) です")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(urls("https://example.com/p?q=1&r=a%20b#sec-2")).toEqual(["https://example.com/p?q=1&r=a%20b#sec-2"]);
    expect(urls("http://localhost:1420/ 起動")).toEqual(["http://localhost:1420/"]);
  });
  test("http と https 以外はリンクにしない", () => {
    expect(urls("javascript:alert(1) と ftp://x.com と mailto:a@b.c と file:///etc/passwd")).toEqual([]);
  });
  test("前後の文字をそのまま残す", () => {
    const s = "前 https://a.example/b 後";
    expect(splitLinks(s).map((p) => p.text).join("")).toBe(s);
    expect(splitLinks("URL なし")).toEqual([{ text: "URL なし" }]);
  });
  test("複数の URL", () => {
    expect(urls("https://a.example と https://b.example/x,")).toEqual(["https://a.example", "https://b.example/x"]);
  });
});

describe("safeUrl", () => {
  test("http と https だけを通す", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com/");
    expect(safeUrl("HTTP://Example.com/a")).toBe("http://example.com/a");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("file:///etc/passwd")).toBeNull();
    expect(safeUrl("mailto:a@b.c")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
  });
});

describe("TERM_URL_RE", () => {
  const m = (s: string) => s.match(TERM_URL_RE)?.[0] ?? null;
  test("日本語と文の終わりの記号を含めない", () => {
    expect(m("⏺ PR: https://github.com/konaito/ClaudeTown/pull/35を見て。")).toBe("https://github.com/konaito/ClaudeTown/pull/35");
    expect(m("see https://example.com/x.")).toBe("https://example.com/x");
    expect(m("(https://example.com/a?b=1)")).toBe("https://example.com/a?b=1");
    expect(m("http://localhost:1420/ 起動")).toBe("http://localhost:1420/");
  });
  test("http と https 以外は取らない", () => {
    expect(m("javascript:alert(1) file:///etc/passwd")).toBeNull();
  });
});
