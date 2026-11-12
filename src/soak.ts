// 長時間の記録（#15、scripts/soak.ts）で、画面を人の代わりに動かす。VITE_FC_SOAK を付けてビルドしたときだけ入る。
//   town    町を出したまま、SWITCH_MS ごとに次のセッションを選んでチャットを開く（会話の取得と切り替えを続ける）
//   reopen  1つのセッションを選び、35秒待ってから、ターミナルのタブを REOPEN 回開いて閉じる。開くたびに描けているかを数える
//   misroute #36 の再現。名前が同じ2世帯を交互に選び、SENDS 回送る。送る直前の選択と送信先の表示を残す（届いた先は外で mock に聞く）
//   check10 #10 の確かめ。モックの長い会話（FC_MOCK_CONV）で、吹き出しの並び、増えた分、送った文の仮の表示、選択肢、切り替えを見る
// 進み具合は perf_log（FC_PERF_LOG のファイル）に1行の JSON で書く。外の scripts/soak.ts がそれを読む
import { call } from "./bridge";

const MODE = import.meta.env.VITE_FC_SOAK as string;
const SWITCH_MS = Number(import.meta.env.VITE_FC_SOAK_SWITCH_MS ?? 10 * 60_000);
const REOPEN = Number(import.meta.env.VITE_FC_SOAK_REOPEN ?? 100);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (o: Record<string, unknown>) => call("perf_log", { line: JSON.stringify({ soak: MODE, at: Date.now(), ...o }) }).catch(() => {});
// 押す先はカードそのもの（data-aid の包みの最初の子）。包みには onClick が無い
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-aid]")].map((w) => Object.assign(w.firstElementChild as HTMLElement, { aid: w.dataset.aid }));
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".tabs button")].find((b) => b.textContent === label);

async function until<T>(f: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("待ちきれなかった");
    await sleep(200);
  }
}

async function town() {
  await until(() => cards().length > 0);
  for (let i = 0; ; i++) {
    const cs = cards();
    const c = cs[i % cs.length];
    c.click();
    await sleep(500);
    tab("チャット")?.click();
    log({ ev: "select", i, id: c.aid, cards: cs.length, bubbles: document.querySelectorAll(".talk .msg, .talk .tool-line").length });
    await sleep(SWITCH_MS);
  }
}

async function reopen() {
  const c = await until(() => cards()[0]);
  c.click();
  // 始めの記録（外の scripts/soak.ts が起動から30秒で取る）が済むまで待つ
  await sleep(35_000);
  await until(() => tab("ターミナル"));
  log({ ev: "start", id: c.aid });
  // 開くたびに、描けているかを見る。WebGL の文脈が生きている、文脈を失った知らせが来ていない、「起動中…」が消えている
  let lost = 0, drawn = 0, gl = 0;
  const t0 = Date.now();
  for (let i = 1; i <= REOPEN; i++) {
    tab("ターミナル")!.click();
    await until(() => document.querySelector(".xterm"));
    const ok = await until(() => !document.querySelector(".term-status"), 10_000).then(() => true, () => false);
    // 文脈を失った知らせは、canvas が画面に付いている間だけ数える（閉じるときに自分で手放した分は数えない）
    const onLost = () => lost++;
    const cvs = [...document.querySelectorAll<HTMLCanvasElement>(".term canvas")];
    for (const cv of cvs) cv.addEventListener("webglcontextlost", onLost);
    await sleep(400);
    const live = cvs.map((cv) => cv.getContext("webgl2")).filter((x): x is WebGL2RenderingContext => !!x && !x.isContextLost());
    if (ok) drawn++;
    if (live.length > 0) gl++;
    for (const cv of cvs) cv.removeEventListener("webglcontextlost", onLost);
    tab("チャット")!.click();
    await until(() => !document.querySelector(".xterm"));
    await sleep(200);
    if (i % 10 === 0) log({ ev: "reopen", i, drawn, gl, lost, ms: Date.now() - t0 });
  }
  log({ ev: "done", drawn, gl, lost });
}

/** 会話の欄の「仮の会話 N」の番号を、上から順に */
const nums = () => [...(document.querySelector(".talk")?.textContent ?? "").matchAll(/仮の会話 (\d+)）/g)].map((m) => Number(m[1]));
const ordered = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
const talkName = () => (document.querySelector(".talk")?.textContent ?? "").match(/（(\S+?)の仮の会話/)?.[1] ?? null;

async function check10() {
  const r: Record<string, unknown> = {};
  const cs = await until(() => cards().length >= 2 && cards());
  cs[0].click();
  await until(() => nums().length >= 20);
  await sleep(1000);
  const a = nums();
  r.open = { count: a.length, first: a[0], last: a[a.length - 1], ordered: ordered(a), who: talkName() };
  // 待つ間、1秒ごとに、選ばれているカードと会話の欄の持ち主を残す
  const trace: string[] = [];
  for (let k = 0; k < 11; k++) {
    await sleep(1000);
    trace.push(`${(document.querySelector(".fnode.open [data-aid]") as HTMLElement | null)?.dataset.aid?.slice(0, 8)}:${talkName()}`);
  }
  r.trace = trace;
  r.ids = cards().map((c) => `${c.aid?.slice(0, 8)}`);
  const b = nums();
  r.grow = { who: talkName(), last: b[b.length - 1], added: b[b.length - 1] - a[a.length - 1], ordered: ordered(b) };
  // 送る。仮の吹き出しが出て、会話に出たら消え、返事の選択肢が出る
  const text = `確かめの文 ${Date.now()}`;
  const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(200);
  document.querySelector<HTMLButtonElement>(".composer .send")!.click();
  const pendingSeen = await until(() => document.querySelector(".msg.pending"), 5000).then(() => true, () => false);
  const t0 = Date.now();
  await until(() => !document.querySelector(".msg.pending") && [...document.querySelectorAll(".msg.me")].some((m) => m.textContent?.includes(text)), 15_000);
  r.send = { pendingSeen, clearedMs: Date.now() - t0, mine: [...document.querySelectorAll(".msg.me")].filter((m) => m.textContent?.includes(text)).length };
  await until(() => document.querySelectorAll(".choices .choice").length > 0, 10_000).catch(() => null);
  r.choices = [...document.querySelectorAll(".choices .choice")].map((c) => c.textContent);
  r.tailA = (document.querySelector(".talk") as HTMLElement).innerText.slice(-300);
  // 切り替え。前のセッションの吹き出しが残らない（reset で置き換わる）
  const nameA = talkName();
  cards()[1].click();
  await until(() => talkName() && talkName() !== nameA, 15_000).catch(() => null);
  await sleep(1000);
  const c = nums();
  r.switch = { from: nameA, to: talkName(), count: c.length, ordered: ordered(c), leftover: (document.querySelector(".talk")?.textContent ?? "").includes(text) || (document.querySelector(".talk")?.textContent ?? "").includes(`${nameA}の仮の会話`) };
  // 戻る
  cards()[0].click();
  await until(() => talkName() === nameA, 15_000).catch(() => null);
  await sleep(1500);
  const d = nums();
  r.back = { who: talkName(), count: d.length, ordered: ordered(d), mine: [...document.querySelectorAll(".msg.me")].filter((m) => m.textContent?.includes(text)).length };
  log({ ev: "check10", ...r });
}

async function misroute() {
  const n = Number(import.meta.env.VITE_FC_SOAK_SENDS ?? 20);
  await until(() => cards().length >= 2);
  for (let i = 0; i < n; i++) {
    const c = cards()[i % 2];
    c.click();
    // 切り替えてすぐ送る回と、会話が出てから送る回を混ぜる
    if (i % 4 < 2) await until(() => nums().length > 0 && talkName() !== null, 15_000).catch(() => null);
    await sleep(i % 3 === 0 ? 50 : 1500);
    const text = `誤配の試し ${i} ${Date.now()}`;
    const shown = { clicked: c.aid, selected: (document.querySelector(".fnode.open [data-aid]") as HTMLElement | null)?.dataset.aid, to: document.querySelector(".composer .to")?.textContent, talk: talkName() };
    const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
    document.querySelector<HTMLButtonElement>(".composer .send")!.click();
    await sleep(300);
    log({ ev: "send", i, text, ...shown, after: (document.querySelector(".fnode.open [data-aid]") as HTMLElement | null)?.dataset.aid });
    await sleep(1500);
  }
  log({ ev: "done" });
}

(MODE === "reopen" ? reopen() : MODE === "check10" ? check10() : MODE === "misroute" ? misroute() : town()).catch((e) => log({ ev: "error", message: String(e) }));
