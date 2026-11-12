// ポケモンスキンで使う3段進化の系統の一覧（src/kid/pokemon-lines.json）を作る。
// 画像はリポジトリに入れない。JSON に書くのは図鑑番号と英名だけで、画像は実行時に PokeAPI/sprites から読む。
//
//   bun run scripts/pokemon-lines.ts
//
// 1. PokeAPI の evolution-chain を全部読み、根から3段目まで続く道を取り出す。分岐する系統は PokeAPI の並びで最初の道にする。
// 2. PokeAPI/sprites の sprites/pokemon/other/showdown/ のファイル一覧を、決めたコミットで読む。
// 3. 3体の GIF を実際に取得し、フレーム数が2以上（動く）かを数える。欠けか1フレームの体がいる系統は除外し、理由を出す。
import { writeFileSync } from "node:fs";

/** 確かめたときの PokeAPI/sprites のコミット。JSON の sha に書き、アプリ（src/kid/pokemon.ts）はこのコミットの URL を読む */
export const SPRITES_SHA = "1b3b7c0a538dd2226ae08d0d2f8955125075bbd4";
const RAW = `https://raw.githubusercontent.com/PokeAPI/sprites/${SPRITES_SHA}/sprites/pokemon/other/showdown`;
const OUT = new URL("../src/kid/pokemon-lines.json", import.meta.url);

type Node = { species: { name: string; url: string }; evolves_to: Node[] };
const idOf = (n: Node) => Number(n.species.url.replace(/\/$/, "").split("/").pop());

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

/** GIF のフレーム（画像記述子）の数。ブロックを順にたどって数える */
export function gifFrames(b: Uint8Array): number {
  if (String.fromCharCode(...b.slice(0, 3)) !== "GIF") throw new Error("GIF ではない");
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  const skipSub = () => { while (b[p] !== 0) p += b[p] + 1; p++; };
  let n = 0;
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3b) break;
    if (t === 0x21) { p++; skipSub(); continue; }
    if (t === 0x2c) {
      n++;
      const flags = b[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; // LZW の最小コードの長さ
      skipSub();
      continue;
    }
    throw new Error(`知らないブロック 0x${t.toString(16)}（位置 ${p - 1}）`);
  }
  return n;
}

async function main() {
  const list = await json<{ results: { url: string }[] }>("https://pokeapi.co/api/v2/evolution-chain?limit=1000");
  const chains: { id: number; chain: Node }[] = [];
  for (let i = 0; i < list.results.length; i += 16) {
    chains.push(...(await Promise.all(list.results.slice(i, i + 16).map((r) => json<{ id: number; chain: Node }>(r.url)))));
  }
  const paths = (n: Node, pre: Node[] = []): Node[][] => {
    const cur = [...pre, n];
    return n.evolves_to.length ? n.evolves_to.flatMap((c) => paths(c, cur)) : [cur];
  };
  const lines: { chain: number; ids: number[]; names: string[]; branched: boolean }[] = [];
  for (const c of chains.sort((a, b) => a.id - b.id)) {
    const ps = paths(c.chain).filter((p) => p.length >= 3);
    if (!ps.length) continue;
    if (ps.some((p) => p.length > 3)) throw new Error(`4段以上の系統がある（chain ${c.id}）。役割の割り当てを考え直す`);
    const p = ps[0];
    lines.push({ chain: c.id, ids: p.map(idOf), names: p.map((n) => n.species.name), branched: ps.length > 1 });
  }

  // ファイル一覧（GitHub の git tree。contents の口は1000件で切れるので使わない）
  const other = await json<{ name: string; sha: string }[]>(`https://api.github.com/repos/PokeAPI/sprites/contents/sprites/pokemon/other?ref=${SPRITES_SHA}`);
  const dir = other.find((x) => x.name === "showdown");
  if (!dir) throw new Error("showdown のディレクトリが無い");
  const tree = await json<{ truncated: boolean; tree: { path: string; type: string }[] }>(`https://api.github.com/repos/PokeAPI/sprites/git/trees/${dir.sha}`);
  if (tree.truncated) throw new Error("ファイル一覧が途中で切れた");
  const have = new Set(tree.tree.filter((t) => t.type === "blob" && /^\d+\.gif$/.test(t.path)).map((t) => Number(t.path.slice(0, -4))));
  console.error(`showdown の GIF: ${have.size} 件`);

  const ok: { ids: number[]; names: string[] }[] = [];
  const dropped: string[] = [];
  for (const l of lines) {
    const lack = l.ids.filter((id) => !have.has(id));
    if (lack.length) { dropped.push(`${l.names.join("→")}: GIF が無い ${lack.join(",")}`); continue; }
    const frames = await Promise.all(l.ids.map(async (id) => {
      const r = await fetch(`${RAW}/${id}.gif`);
      if (!r.ok) return -r.status;
      return gifFrames(new Uint8Array(await r.arrayBuffer()));
    }));
    const bad = l.ids.filter((_, i) => frames[i] < 2);
    if (bad.length) { dropped.push(`${l.names.join("→")}: 動かないか取れない ${bad.map((id) => `${id}(${frames[l.ids.indexOf(id)]})`).join(",")}`); continue; }
    ok.push({ ids: l.ids, names: l.names });
    console.error(`${l.names.join("→")} フレーム ${frames.join("/")}${l.branched ? "（分岐。最初の道）" : ""}`);
  }
  console.error(`3段の系統 ${lines.length}、うち分岐 ${lines.filter((l) => l.branched).length}、使える ${ok.length}、除外 ${dropped.length}`);
  for (const d of dropped) console.error(`除外: ${d}`);
  writeFileSync(OUT, JSON.stringify({
    _comment: "scripts/pokemon-lines.ts で生成した。手で直さない。画像は含まず、図鑑番号と英名だけ",
    sha: SPRITES_SHA,
    lines: ok.map((l) => [l.ids, l.names]),
  }) + "\n");
}

if (import.meta.main) await main();
