// ポケモンスキンで使う3段進化の系統の一覧と、絵の使い方（src/kid/pokemon-lines.json）を作る。
// 画像はリポジトリに入れない。JSON に書くのは図鑑番号と英名、止め絵しか無い番号、余白を切る矩形だけで、
// 画像は実行時に PokeAPI/sprites から読む。
//
//   bun run scripts/pokemon-lines.ts            系統の一覧は今のまま、絵の使い方だけ作り直す
//   bun run scripts/pokemon-lines.ts --relist   系統の一覧も PokeAPI から作り直す
//
// 系統の一覧は、件数か並びが変わると全世帯の系統が入れ替わる（src/kid/pokemon.ts の lineOf）。--relist は入れ替えてよいときだけ使う。
//
// 絵は2Dのドット絵（ブラック・ホワイトの形）にする。決めたコミットの PokeAPI/sprites で、番号ごとに次の順で選ぶ。
// 1. versions/generation-v/black-white/animated/{id}.gif。作業中に動かす。#650 以降は PokeAPI/sprites が後から足した分だけあり、欠けがある
// 2. 1 が無い番号は versions/generation-v/black-white/{id}.png（止め絵）。作業中も止め絵のまま跳ねるだけになる。この番号を still に書く
// 3. 全フレームの不透明な部分の外接矩形を測る。余白のある絵は crop に [x, y, 幅, 高さ, 元の幅, 元の高さ] を書く。
//    アプリは余白を切ってから箱に収める。余白ごと収めると、余白の多い絵だけ小さく浮く
// どちらも無い番号、動かないアニメ（1フレーム）は、--relist ではその系統を除き、そうでなければ止まる。
import { readFileSync, writeFileSync } from "node:fs";
import { GifReader } from "omggif";
import { PNG } from "pngjs";

/** 確かめたときの PokeAPI/sprites のコミット。JSON の sha に書き、アプリ（src/kid/pokemon.ts）はこのコミットの URL を読む */
export const SPRITES_SHA = "1b3b7c0a538dd2226ae08d0d2f8955125075bbd4";
const BW = "sprites/pokemon/versions/generation-v/black-white";
const RAW = `https://raw.githubusercontent.com/PokeAPI/sprites/${SPRITES_SHA}/${BW}`;
const OUT = new URL("../src/kid/pokemon-lines.json", import.meta.url);

type Node = { species: { name: string; url: string }; evolves_to: Node[] };
type Line = { ids: number[]; names: string[] };
const idOf = (n: Node) => Number(n.species.url.replace(/\/$/, "").split("/").pop());

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

async function bytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** RGBA の並びから、不透明な画素の外接矩形 [x, y, 幅, 高さ]。全部透明なら null */
export function opaqueBox(rgba: Uint8Array, w: number, h: number): [number, number, number, number] | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** GIF のフレーム数と、全フレームを重ねた不透明な部分の外接矩形 */
export function gifInfo(b: Uint8Array): { frames: number; w: number; h: number; box: [number, number, number, number] | null } {
  const g = new GifReader(b);
  // フレームを消さずに重ね続け、どれかのフレームで一度でも描かれた画素を残す
  const acc = new Uint8Array(g.width * g.height * 4);
  for (let i = 0; i < g.numFrames(); i++) g.decodeAndBlitFrameRGBA(i, acc);
  return { frames: g.numFrames(), w: g.width, h: g.height, box: opaqueBox(acc, g.width, g.height) };
}

export function pngInfo(b: Uint8Array): { w: number; h: number; box: [number, number, number, number] | null } {
  const p = PNG.sync.read(Buffer.from(b));
  return { w: p.width, h: p.height, box: opaqueBox(p.data, p.width, p.height) };
}

/** PokeAPI の evolution-chain を全部読み、根から3段目まで続く道を取り出す。分岐する系統は PokeAPI の並びで最初の道にする */
async function relist(): Promise<Line[]> {
  const list = await json<{ results: { url: string }[] }>("https://pokeapi.co/api/v2/evolution-chain?limit=1000");
  const chains: { id: number; chain: Node }[] = [];
  for (let i = 0; i < list.results.length; i += 16) {
    chains.push(...(await Promise.all(list.results.slice(i, i + 16).map((r) => json<{ id: number; chain: Node }>(r.url)))));
  }
  const paths = (n: Node, pre: Node[] = []): Node[][] => {
    const cur = [...pre, n];
    return n.evolves_to.length ? n.evolves_to.flatMap((c) => paths(c, cur)) : [cur];
  };
  const lines: Line[] = [];
  for (const c of chains.sort((a, b) => a.id - b.id)) {
    const ps = paths(c.chain).filter((p) => p.length >= 3);
    if (!ps.length) continue;
    if (ps.some((p) => p.length > 3)) throw new Error(`4段以上の系統がある（chain ${c.id}）。役割の割り当てを考え直す`);
    lines.push({ ids: ps[0].map(idOf), names: ps[0].map((n) => n.species.name) });
  }
  return lines;
}

/** 決めたコミットで、ディレクトリの中のファイル名を全部読む（GitHub の git tree。contents の口は1000件で切れるので使わない） */
async function files(path: string): Promise<Set<string>> {
  let sha = SPRITES_SHA;
  for (const part of path.split("/")) {
    const t = await json<{ tree: { path: string; sha: string; type: string }[] }>(`https://api.github.com/repos/PokeAPI/sprites/git/trees/${sha}`);
    const d = t.tree.find((x) => x.path === part && x.type === "tree");
    if (!d) throw new Error(`${path} の ${part} が無い`);
    sha = d.sha;
  }
  const t = await json<{ truncated: boolean; tree: { path: string; type: string }[] }>(`https://api.github.com/repos/PokeAPI/sprites/git/trees/${sha}`);
  if (t.truncated) throw new Error(`${path} のファイル一覧が途中で切れた`);
  return new Set(t.tree.filter((x) => x.type === "blob").map((x) => x.path));
}

type Sprite = { id: number; still: boolean; crop: number[] | null } | { id: number; error: string };

async function sprite(id: number, anim: Set<string>, stills: Set<string>): Promise<Sprite> {
  const crop = (w: number, h: number, box: number[] | null) =>
    !box ? null : box[0] === 0 && box[1] === 0 && box[2] === w && box[3] === h ? null : [...box, w, h];
  if (anim.has(`${id}.gif`)) {
    const g = gifInfo(await bytes(`${RAW}/animated/${id}.gif`));
    if (g.frames < 2) return { id, error: `アニメが動かない（${g.frames}フレーム）` };
    if (!g.box) return { id, error: "アニメが全部透明" };
    return { id, still: false, crop: crop(g.w, g.h, g.box) };
  }
  if (stills.has(`${id}.png`)) {
    const p = pngInfo(await bytes(`${RAW}/${id}.png`));
    if (!p.box) return { id, error: "止め絵が全部透明" };
    return { id, still: true, crop: crop(p.w, p.h, p.box) };
  }
  return { id, error: "アニメも止め絵も無い" };
}

async function main() {
  const relisting = process.argv.includes("--relist");
  const cur = JSON.parse(readFileSync(OUT, "utf8")) as { lines: [number[], string[]][] };
  const lines: Line[] = relisting ? await relist() : cur.lines.map(([ids, names]) => ({ ids, names }));

  const anim = await files(`${BW}/animated`);
  const stills = await files(BW);
  console.error(`BW のアニメ ${[...anim].filter((f) => f.endsWith(".gif")).length} 件、止め絵 ${[...stills].filter((f) => f.endsWith(".png")).length} 件`);

  const ids = [...new Set(lines.flatMap((l) => l.ids))].sort((a, b) => a - b);
  const got = new Map<number, Sprite>();
  for (let i = 0; i < ids.length; i += 16) {
    for (const s of await Promise.all(ids.slice(i, i + 16).map((id) => sprite(id, anim, stills)))) got.set(s.id, s);
  }

  const ok: Line[] = [];
  const dropped: string[] = [];
  for (const l of lines) {
    const bad = l.ids.map((id) => got.get(id)!).filter((s) => "error" in s);
    if (bad.length) dropped.push(`${l.names.join("→")}: ${bad.map((s) => `${s.id} ${(s as { error: string }).error}`).join(", ")}`);
    else ok.push(l);
  }
  for (const d of dropped) console.error(`除外: ${d}`);
  if (dropped.length && !relisting) throw new Error(`今の系統に絵の無い番号がある（${dropped.length} 系統）。系統の一覧は変えないので止める`);

  const used = [...new Set(ok.flatMap((l) => l.ids))].sort((a, b) => a - b).map((id) => got.get(id)! as Extract<Sprite, { still: boolean }>);
  const still = used.filter((s) => s.still).map((s) => s.id);
  const crop = Object.fromEntries(used.filter((s) => s.crop).map((s) => [s.id, s.crop]));
  console.error(`系統 ${ok.length}（除外 ${dropped.length}）、番号 ${used.length}、うちアニメ ${used.length - still.length}、止め絵 ${still.length}、余白を切る ${Object.keys(crop).length}`);
  console.error(`止め絵の番号: ${still.join(",")}`);
  writeFileSync(OUT, JSON.stringify({
    _comment: "scripts/pokemon-lines.ts で生成した。手で直さない。画像は含まず、図鑑番号と英名、止め絵しか無い番号（still）、余白を切る矩形（crop: [x, y, 幅, 高さ, 元の幅, 元の高さ]）だけ",
    sha: SPRITES_SHA,
    lines: ok.map((l) => [l.ids, l.names]),
    still,
    crop,
  }) + "\n");
}

if (import.meta.main) await main();
