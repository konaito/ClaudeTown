import { describe, expect, test } from "bun:test";
import { placeLabel, placeName, placeTime, recentPlaces, withoutPlace } from "./places";

const H = "/Users/k";
const base = { roots: [H], lobby: `${H}/.local/share/ccn/lobby` };

describe("recentPlaces", () => {
  test("places と sessions を合わせ、新しい順に並べる", () => {
    const r = recentPlaces({
      ...base,
      places: [
        { path: `${H}/Documents/a`, lastUsedAt: 300 },
        { path: `${H}/Documents/b`, lastUsedAt: null },
        { path: `${H}/OrbStack`, lastUsedAt: null },
      ],
      sessions: [
        { cwd: `${H}/Documents/b`, lastActivityAt: 500 },
        { cwd: `${H}/Documents`, lastActivityAt: 400 },
      ],
    });
    expect(r).toEqual([
      { path: `${H}/Documents/b`, at: 500 },
      { path: `${H}/Documents`, at: 400 },
      { path: `${H}/Documents/a`, at: 300 },
    ]);
  });

  test("候補の下の cwd（worktree など）は候補にまとめ、新しいほうの時刻を使う", () => {
    const r = recentPlaces({
      ...base,
      places: [{ path: `${H}/Documents/cam`, lastUsedAt: 100 }],
      sessions: [{ cwd: `${H}/Documents/cam/.claude/worktrees/x`, lastActivityAt: 200 }],
    });
    expect(r).toEqual([{ path: `${H}/Documents/cam`, at: 200 }]);
  });

  test("深い候補を先に当てる", () => {
    const r = recentPlaces({
      ...base,
      places: [{ path: `${H}/Documents/a` }, { path: `${H}/Documents/a/sub` }],
      sessions: [{ cwd: `${H}/Documents/a/sub/x`, lastActivityAt: 1 }],
    });
    expect(r.map((p) => p.path)).toEqual([`${H}/Documents/a/sub`]);
  });

  test("roots の外と受け口は出さない。cwd や時刻が無いセッションは飛ばす", () => {
    const r = recentPlaces({
      ...base,
      places: [],
      sessions: [
        { cwd: "/private/tmp", lastActivityAt: 9 },
        { cwd: `${H}/.local/share/ccn/lobby`, lastActivityAt: 9 },
        { cwd: null, lastActivityAt: 9 },
        { cwd: `${H}/Documents/z`, lastActivityAt: null },
        { cwd: `${H}/Documents/y/`, lastActivityAt: 3 },
      ],
    });
    expect(r).toEqual([{ path: `${H}/Documents/y`, at: 3 }]);
  });

  test("古い ccn（places が null）でもセッションの cwd から作る。件数で切る", () => {
    const sessions = Array.from({ length: 30 }, (_, i) => ({ cwd: `${H}/p${i}`, lastActivityAt: i }));
    const r = recentPlaces({ ...base, places: null, sessions });
    expect(r).toHaveLength(20);
    expect(r[0]).toEqual({ path: `${H}/p29`, at: 29 });
  });

  test("roots の名前に似た別のディレクトリを roots の内側と見ない", () => {
    const r = recentPlaces({ ...base, places: null, sessions: [{ cwd: `${H}x/a`, lastActivityAt: 1 }] });
    expect(r).toEqual([]);
  });
});

test("placeTime は月-日 時:分", () => {
  expect(placeTime(new Date(2026, 10, 21, 9, 5).getTime())).toBe("11-21 09:05");
});

test("placeLabel はホームを ~ にする", () => {
  expect(placeLabel("/Users/konaito/Documents/meta")).toBe("~/Documents/meta");
  expect(placeLabel("/private/tmp")).toBe("/private/tmp");
});

describe("placeName（#99）", () => {
  test("パスの最後のディレクトリ名。ホームは ~、ルートは /", () => {
    expect(placeName("/Users/me/Documents/app")).toBe("app");
    expect(placeName("/Users/me/Documents/app/")).toBe("app");
    expect(placeName("/private/tmp")).toBe("tmp");
    expect(placeName("/Users/me")).toBe("~");
    expect(placeName("/")).toBe("/");
  });
});

describe("withoutPlace（新しい世帯の置き場所を除く、2026-11-21 本人の決定）", () => {
  const list = [
    { path: `${H}/Documents/meta`, at: 3 },
    { path: `${H}/Documents/app`, at: 2 },
    { path: `${H}/Documents/meta-old`, at: 1 },
  ];
  test("設定が無ければ既定の場所（~/Documents/meta）を除く。名前の似た場所は残す", () => {
    expect(withoutPlace(list, null, `${H}/Documents/meta`).map((p) => p.path)).toEqual([`${H}/Documents/app`, `${H}/Documents/meta-old`]);
  });
  test("設定を変えたら、変えた先を除き、既定の場所は出す", () => {
    expect(withoutPlace(list, `${H}/Documents/app/`, `${H}/Documents/meta`).map((p) => p.path)).toEqual([`${H}/Documents/meta`, `${H}/Documents/meta-old`]);
  });
  test("どちらも分からなければ除かない（ブラウザ版）", () => {
    expect(withoutPlace(list, null, undefined)).toBe(list);
  });
});
