import { describe, expect, test } from "bun:test";
import { startupSpans } from "./startup";

describe("startupSpans", () => {
  test("Rust の起動の時刻から、読み込み開始、窓の描画、町の描画までを引く", () => {
    const r = startupSpans({ procStartMs: 1000 }, { navStartMs: 1300, shellPaintedAt: 1800, paintedAt: 2100, vis: "visible" });
    expect(r.spans).toEqual({ toNavStartMs: 300, toShellPaintMs: 800, toTownPaintMs: 1100 });
    expect(r.bad).toEqual([]);
  });

  test("窓が隠れて rAF が来なかった回は、区間を null にして無効にする", () => {
    const r = startupSpans({ procStartMs: 1000 }, { navStartMs: 1300, shellPaintedAt: 0, paintedAt: 0, vis: "hidden" });
    expect(r.spans).toEqual({ toNavStartMs: 300, toShellPaintMs: null, toTownPaintMs: null });
    expect(r.bad).toEqual(["窓が見えていない（hidden）", "窓の最初の描画の時刻が無い", "町の最初の描画の時刻が無い"]);
  });

  test("Rust の起動の行が無ければ無効", () => {
    const r = startupSpans(undefined, { navStartMs: 1300, shellPaintedAt: 1800, paintedAt: 2100, vis: "visible" });
    expect(r.spans.toTownPaintMs).toBeNull();
    expect(r.bad).toContain("Rust の起動の時刻（procStartMs）が無い");
  });

  test("町の描画が窓の描画より先なら無効", () => {
    const r = startupSpans({ procStartMs: 1000 }, { navStartMs: 1300, shellPaintedAt: 2200, paintedAt: 2100, vis: "visible" });
    expect(r.bad).toEqual(["窓の描画（1200ms）が町の描画（1100ms）より後"]);
  });

  test("起動より前の時刻があれば無効", () => {
    const r = startupSpans({ procStartMs: 1000 }, { navStartMs: 900, shellPaintedAt: 1800, paintedAt: 2100, vis: "visible" });
    expect(r.bad).toEqual(["起動より前の時刻がある"]);
  });
});
