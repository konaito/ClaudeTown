// ブラウザの /api/... と /n/<町>/api/... を、ccn の入口（CCN_ORIGIN）へそのまま中継する。
// ccn は別オリジンからの要求を 403 で断る（guardCsrf）。この Worker は画面と同じオリジンで受けるので、ブラウザから見ると同一オリジンになる。
// ccn の Access アプリ（ccn）には、このアプリ（claude-town）からの Linked App Token を通すポリシー（town-linked）を足してある。
// 受け取った Access の JWT を Cf-Access-Token で渡すと、ccn には人（email）の呼び手として届く。サービストークンの秘密は持たない。
import type { Context } from 'hono';

const CCN_ORIGIN = 'https://ccn.fybe.jp';
// 渡すのは、中身の解釈に要る最小のヘッダーだけ。Origin、Sec-Fetch-*、Cookie は渡さない（渡すと ccn の CSRF の確認で 403 になる）
const FORWARD = ['content-type', 'accept', 'last-event-id'];

export async function proxyToCcn(c: Context): Promise<Response> {
  const jwt = c.req.header('cf-access-jwt-assertion');
  if (!jwt) return c.json({ error: 'no access token' }, 401);
  const url = new URL(c.req.url);
  const headers = new Headers({ 'cf-access-token': jwt });
  for (const h of FORWARD) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(new URL(url.pathname + url.search, CCN_ORIGIN), {
      method: c.req.method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      redirect: 'manual',
      signal: c.req.raw.signal,
    });
  } catch (e) {
    return c.json({ error: `ccn unreachable: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  // Access のログインへのリダイレクトはブラウザに返さない（画面の Access とは別の門）
  if (upstream.status >= 300 && upstream.status < 400) return c.json({ error: `ccn access redirect ${upstream.status}` }, 502);
  const out = new Headers();
  for (const h of ['content-type', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
