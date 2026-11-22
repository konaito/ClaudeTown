// 書き込みの要求が、この画面と同じオリジンから来たかを確かめる（#167）。
// lib/proxy.ts は Origin と Sec-Fetch-* を ccn へ渡さないので、ccn の CSRF の確認（guardCsrf）はここでは働かない。
// そのため、ccn と同じ確認をこの Worker の入口で行う。
// GET と HEAD は確かめない（EventSource の GET やアドレス欄からの読み込みを止めないため）。
// Origin も Sec-Fetch-Site も無い要求（ブラウザ以外の呼び手）は通す。ブラウザは書き込みの要求に Origin を付ける。

/** 断る理由を返す。通すなら null */
export function crossOriginReason(req: Request): string | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return `sec-fetch-site ${site}`;
  const origin = req.headers.get('origin');
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return `origin ${origin}`;
    }
    if (host !== new URL(req.url).host) return `origin ${origin}`;
  }
  return null;
}
