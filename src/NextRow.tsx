import type { Mail } from "./mail";

export function NextRow({ mails, working, total, onOpen }: {
  mails: Mail[]; working: number; total: number;
  onOpen: (m: Mail, chat?: boolean) => void;
}) {
  // 先頭が大きい1枚、続く2件が小さいチップ、残りは「ほか N 件」。並びは src/mail.ts（親が先、その中は待ちが古い順）
  const first = mails[0];
  const rest = mails.slice(1, 3);
  const hidden = mails.length - 1 - rest.length;
  const icon = (k: Mail["kind"]) => (k === "approval" ? "✋" : k === "reply" ? "💬" : "✓");
  const mainText = (m: Mail) => {
    const n = m.agent.name;
    return m.kind === "approval" ? `${n}の承認待ちを確認する` : m.kind === "reply" ? `${n}に返事する` : `${n}の報告を確認する`;
  };
  const chipText = (m: Mail) => (m.kind === "approval" ? `${m.agent.name}の承認待ち` : m.kind === "reply" ? `${m.agent.name}から返事待ち` : `${m.agent.name}の報告を確認`);
  return (
    <div className="next-row">
      <span className="next-label">お便り</span>
      {first ? (
        <div className={`next-main nm-${first.kind}`}>
          <span className="next-icon">{icon(first.kind)}</span>
          <button className="next-text" onClick={() => onOpen(first)}>{mainText(first)}</button>
          <button className="pane-btn" onClick={() => onOpen(first, true)}>チャットへ</button>
        </div>
      ) : (
        <div className="next-main nm-calm">
          <span className="next-text calm">
            {total === 0 ? "いまは誰もいない" : working > 0 ? `いまはあなたの番じゃない。${working}人が作業中` : "みんな待機中。頼みたい子をクリック"}
          </span>
        </div>
      )}
      {rest.length > 0 && <span className="next-sep" />}
      {rest.map((m) => (
        <button key={m.agent.id} className="next-chip" onClick={() => onOpen(m)}>
          <span>{icon(m.kind)}</span>{chipText(m)}
        </button>
      ))}
      {hidden > 0 && <span className="next-more">ほか{hidden}件</span>}
    </div>
  );
}
