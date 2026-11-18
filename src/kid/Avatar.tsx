// キャラのアバター。体は Ninja Adventure（CC0）のドット絵、状態の印は Noto Animated Emoji（CC BY 4.0）。
// 配置は docs/research/assets/balance.html の案 A2（本人が選んだ）。印は白い丸の吹き出しで、体の右肩に少し重ねる。
// 作業中は印を出さず、歩きのアニメの足踏みだけで見せる。待機も印を出さない。
import { useEffect, useRef, useState } from "react";
import type { Mood } from "../model";
import "./avatar.css";
import { cropOf, pokemonOf, spriteUrl, useSkin, useStill } from "./pokemon";

// 年齢の印象の点数と世代の目標は Rust（src-tauri/src/avatars.rs の AGES）が正本。ages.json はそこから生成したもの
import AGES from "./ages.json";

/** 状態ごとの印（Noto のコードポイント）。無い状態は印を出さない */
const MARK: Partial<Record<Mood, string>> = {
  approval: "270b", // 手を挙げる
  reply: "1f97a", // お願いの顔
  done: "2705", // チェック
};

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  // 似た名前でも下位のビットが散らばるよう混ぜ直す（murmur3 の最後の処理）
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export type Role = "parent" | "child" | "grandchild";

/**
 * Rust の割り当て（pick）が無いとき（?mock のブラウザ表示など）の代わりの選び方。
 * Rust と同じ重み（世代の目標に近い点数ほど大きい）で、乱数の代わりに seed の hash で引く。
 * 同じ人が大きさの違う複数の場所に描かれるので、描くたびに変わらないよう seed で固定する。
 */
export function fallbackChar(role: Role, seed: string): string {
  const target = AGES.targets[role];
  const items = Object.entries(AGES.ages).map(([c, s]) => [c, Math.exp(-(((s - target) / AGES.sigma) ** 2) / 2)] as const);
  const total = items.reduce((a, [, w]) => a + w, 0);
  let r = (hash(`${role}:${seed}`) / 2 ** 32) * total;
  for (const [c, w] of items) {
    if (r < w) return c;
    r -= w;
  }
  return items[items.length - 1][0];
}

/**
 * size は体の一辺の px。16px の絵の整数倍（32、48、64）にすると、ドット絵がにじまない。
 * 箱の高さは size に吹き出しの余白を足した分で、印の有無で変わらない。
 */
export function Avatar(props: { seed: string; mood: Mood; role: Role; size: number; pick?: { char: string; hue: number } | null; dead?: boolean }) {
  const { skin, rootOf } = useSkin();
  // ポケモンの絵が読めなかった（オフラインなど）ときは、その1体だけ元の絵に戻す。状態が見えなくならないように
  const [broken, setBroken] = useState(false);
  if (skin === "pokemon" && !broken) return <PokemonAvatar {...props} root={rootOf(props.seed)} onBroken={() => setBroken(true)} />;
  return <NinjaAvatar {...props} />;
}

function NinjaAvatar({ seed, mood, role, size, pick, dead }: { seed: string; mood: Mood; role: Role; size: number; pick?: { char: string; hue: number } | null; dead?: boolean }) {
  // 絵は Rust が世代に合わせて町の中で被らないように割り当てたもの（pick）を使う。無いとき（ブラウザ表示など）は seed の hash で選ぶ
  const char = pick?.char ?? fallbackChar(role, seed);
  const hue = pick?.hue ?? 0;
  const walking = mood === "working";
  const mark = MARK[mood];
  return (
    <span className={`fc-avatar fc-${mood} ${dead ? "fc-dead" : ""}`} style={{ ["--fc-size" as string]: `${size}px` }} aria-hidden>
      <span className="fc-body">
        <img src={`/sprites/ninja/characters/${char}/SeparateAnim/${walking ? "Walk" : "Idle"}.png`} alt="" draggable={false}
          style={hue ? { filter: `hue-rotate(${hue}deg)` } : undefined} />
        {/* 倒れた姿（Ninja Adventure の Dead.png。無いキャラは元の絵を傾けて代わりにする） */}
        {dead && <img className="fc-deadimg" src={`/sprites/ninja/characters/${char}/SeparateAnim/Dead.png`} alt="" draggable={false}
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = `/sprites/ninja/characters/${char}/SeparateAnim/Idle.png`; e.currentTarget.classList.add("fallback"); }} />}
      </span>
      {mark && (
        <span className="fc-bubble"><img src={`/sprites/noto/${mark}/64.webp`} alt="" draggable={false} /></span>
      )}
    </span>
  );
}

/**
 * ポケモンスキンの1体（src/kid/pokemon.ts）。世帯の根で系統が決まり、親・子・孫が3段目・2段目・1段目になる。
 * 作業中は GIF をそのまま動かし、少し跳ねさせる。それ以外は1フレームを止めて見せる。印と待機の薄さは元のスキンと同じ。
 * 絵の余白は切ってから箱に収める（止め絵は stillOf で切り、動く GIF は Moving で切る）。
 */
function PokemonAvatar({ seed, mood, role, size, dead, root, onBroken }: { seed: string; mood: Mood; role: Role; size: number; dead?: boolean; root: string; onBroken: () => void }) {
  const p = pokemonOf(root, role);
  const moving = mood === "working" && !dead;
  const still = useStill(p.id, !moving);
  useEffect(() => { if (still.failed) onBroken(); }, [still.failed]);
  const mark = MARK[mood];
  return (
    <span className={`fc-avatar fc-${mood} pk ${dead ? "fc-dead" : ""}`} style={{ ["--fc-size" as string]: `${size}px` }} aria-hidden data-pokemon={p.name} data-seed={seed}>
      <span className="fc-body pk-body">
        {moving
          ? <Moving id={p.id} onBroken={onBroken} />
          : <Still bmp={still.bmp} />}
      </span>
      {mark && (
        <span className="fc-bubble"><img src={`/sprites/noto/${mark}/64.webp`} alt="" draggable={false} /></span>
      )}
    </span>
  );
}

/**
 * 動く GIF。余白のある絵は、不透明な部分の矩形だけが見える枠に入れ、その枠を箱の下の中央に収める
 * （object-fit: contain と同じ収め方）。img の寸法と位置は枠に対する割合で決める。
 */
function Moving({ id, onBroken }: { id: number; onBroken: () => void }) {
  const src = spriteUrl(id);
  const c = cropOf(id);
  if (!c) return <img className="pk-img" src={src} alt="" draggable={false} onError={onBroken} />;
  const [x, y, w, h, W, H] = c;
  const frame = w >= h
    ? { left: 0, width: "100%", height: `${(h / w) * 100}%` }
    : { left: `${((1 - w / h) / 2) * 100}%`, width: `${(w / h) * 100}%`, height: "100%" };
  return (
    <span className="pk-img pk-crop" style={frame}>
      <img className="pk-src" src={src} alt="" draggable={false} onError={onBroken}
        style={{ left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%`, width: `${(W / w) * 100}%`, height: `${(H / h) * 100}%` }} />
    </span>
  );
}

function Still({ bmp }: { bmp: ImageBitmap | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !bmp) return;
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d")?.drawImage(bmp, 0, 0);
  }, [bmp]);
  return <canvas ref={ref} className="pk-img" width={1} height={1} />;
}
