// Cloudflare Access の JWT を Worker でも確かめる（void-auth-cloudflare-access スキル、lifeos と同じ形）。
// Access が門の前にあり、ここは門を通らずに届いた要求を断るための二重の確認。
// 誰を通すかは Access のポリシー（town-owner）だけが決める。Worker に許可リストは持たない。
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { defineMiddleware } from 'void';

type AccessEnv = { CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string; DEV_NO_AUTH?: string };

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksTeam = '';
function keysFor(teamDomain: string) {
  if (!jwks || jwksTeam !== teamDomain) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksTeam = teamDomain;
  }
  return jwks;
}

export default defineMiddleware(async (c, next) => {
  const env = c.env as AccessEnv;
  const url = new URL(c.req.url);
  // 手元の開発サーバーだけ。.env に DEV_NO_AUTH=1 を書いたときに Access の確認を飛ばす
  if (env.DEV_NO_AUTH === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return next();

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  if (!teamDomain || !audience) return c.text('forbidden: access not configured', 403);
  const token = c.req.header('cf-access-jwt-assertion');
  if (!token) return c.text('forbidden: no access token', 403);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keysFor(teamDomain), { issuer: teamDomain, audience }));
  } catch (error) {
    console.warn(`access jwt rejected: ${error}`);
    return c.text('forbidden: invalid access token', 403);
  }
  // deploy の readiness 確認はサービストークン（email なし）で来る
  if (url.pathname.startsWith('/__void/')) return next();
  // それ以外は人のログインだけ
  if (typeof payload.email === 'string' && payload.email) return next();
  return c.text('forbidden: no email in access token', 403);
});
