// middleware/01.access.ts の試験。bun test で走る（web/ で `bun test`）。
// 本番と同じ形（town.fybe.jp、Access の JWT あり）と、手元の開発（DEV_NO_AUTH=1、localhost）の両方で、
// 別オリジンからの書き込みの要求が 403 になり、同じオリジンの POST と EventSource の GET が通ることを確かめる（#167）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import access from '../middleware/01.access';

const TEAM = 'https://team.example.cloudflareaccess.com';
const AUD = 'test-aud';
const PROD = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
const DEV = { DEV_NO_AUTH: '1' };

let token = '';
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  token = await new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  // createRemoteJWKSet が読む鍵の一覧だけを偽物で返す
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function app() {
  const a = new Hono();
  a.use('*', access as never);
  a.all('*', (c) => c.text('passed'));
  return a;
}

async function send(env: Record<string, string>, url: string, method: string, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (env === PROD) h.set('cf-access-jwt-assertion', token);
  const body = method === 'GET' || method === 'HEAD' ? undefined : '{"text":"hi"}';
  const res = await app().fetch(new Request(url, { method, headers: h, body }), env);
  return { status: res.status, text: await res.text() };
}

const cases = [
  { name: '本番', env: PROD, origin: 'https://town.fybe.jp' },
  { name: '手元の開発', env: DEV, origin: 'http://localhost:5173' },
];

for (const { name, env, origin } of cases) {
  const api = `${origin}/api/sessions/abc/message`;
  describe(name, () => {
    test('別のサイトの Origin が付いた POST は 403', async () => {
      const r = await send(env, api, 'POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' });
      expect(r.status).toBe(403);
    });

    test('Origin だけが別のサイトの POST も 403', async () => {
      const r = await send(env, api, 'POST', { origin: 'https://evil.example' });
      expect(r.status).toBe(403);
    });

    test('Sec-Fetch-Site が cross-site の POST も 403', async () => {
      const r = await send(env, api, 'POST', { 'sec-fetch-site': 'cross-site' });
      expect(r.status).toBe(403);
    });

    test('同じサイトの別のサブドメインからの POST も 403', async () => {
      const r = await send(env, api, 'POST', { origin: 'https://other.fybe.jp', 'sec-fetch-site': 'same-site' });
      expect(r.status).toBe(403);
    });

    test('Origin が null の POST は 403', async () => {
      const r = await send(env, api, 'POST', { origin: 'null', 'sec-fetch-site': 'cross-site' });
      expect(r.status).toBe(403);
    });

    test('別のサイトからの DELETE と PUT も 403', async () => {
      for (const m of ['DELETE', 'PUT', 'PATCH']) {
        const r = await send(env, api, m, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
        expect(r.status).toBe(403);
      }
    });

    test('画面のチャットの送信（同じオリジンの POST）は通る', async () => {
      const r = await send(env, api, 'POST', { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
      expect(r).toEqual({ status: 200, text: 'passed' });
    });

    test('Origin も Sec-Fetch-Site も無い POST（ブラウザ以外の呼び手）は通る', async () => {
      const r = await send(env, api, 'POST', { 'content-type': 'application/json' });
      expect(r).toEqual({ status: 200, text: 'passed' });
    });

    test('EventSource の GET（同じオリジン）は通る', async () => {
      const r = await send(env, `${origin}/api/sessions/abc/terminal`, 'GET', { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' });
      expect(r).toEqual({ status: 200, text: 'passed' });
    });

    test('アドレス欄から開いた GET（Sec-Fetch-Site: none）は通る', async () => {
      const r = await send(env, `${origin}/`, 'GET', { 'sec-fetch-site': 'none' });
      expect(r).toEqual({ status: 200, text: 'passed' });
    });
  });
}

test('本番で JWT の無い要求は、同じオリジンでも 403 のまま', async () => {
  const res = await app().fetch(new Request('https://town.fybe.jp/api/sessions', { method: 'POST', headers: { origin: 'https://town.fybe.jp' }, body: '{}' }), PROD);
  expect(res.status).toBe(403);
});
