// 手元の開発で Access の確認を飛ばす口（DEV_NO_AUTH=1）の試験（#244）。web/ で `bun test` で走る。
// Worker が受け取る要求の Host と CF-Connecting-IP は、LAN の別の機械でも好きに付けられる。
// そこで開発サーバーを loopback だけで受けさせ（vite.config.ts）、middleware は loopback の Host だけを通す。
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { resolveConfig } from 'vite';
import access from '../middleware/01.access';

const WEB = join(import.meta.dir, '..');
const DEV = { DEV_NO_AUTH: '1' };

async function devStatus(url: string) {
  const app = new Hono();
  app.use('*', access as never);
  app.all('*', (c) => c.text('passed'));
  const res = await app.fetch(new Request(url), DEV);
  return res.status;
}

describe('middleware: DEV_NO_AUTH=1 で確認を飛ばすのは loopback の Host だけ', () => {
  for (const url of ['http://localhost:5174/', 'http://127.0.0.1:5174/', 'http://[::1]:5174/']) {
    test(`${url} は通る`, async () => {
      expect(await devStatus(url)).toBe(200);
    });
  }
  // 開発サーバーは loopback だけで受けるので、LAN と Tailscale の Host で届く要求は無い。届いたら Access の確認に回す
  for (const url of [
    'http://192.168.1.5:5174/',
    'http://10.0.0.2:5174/',
    'http://100.100.1.1:5174/',
    'http://100.1.2.3:5174/',
    'http://10.evil.example:5174/',
  ]) {
    test(`${url} は 403`, async () => {
      expect(await devStatus(url)).toBe(403);
    });
  }
});

describe('vite.config.ts: DEV_NO_AUTH=1 のときは loopback だけで受ける', () => {
  const saved = process.env.DEV_NO_AUTH;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEV_NO_AUTH;
    else process.env.DEV_NO_AUTH = saved;
  });

  const resolve = (inline: Record<string, unknown> = {}) =>
    resolveConfig({ root: WEB, configFile: join(WEB, 'vite.config.ts'), mode: 'development', logLevel: 'silent', ...inline }, 'serve');

  test('DEV_NO_AUTH=1 なら server.host は localhost', async () => {
    process.env.DEV_NO_AUTH = '1';
    const config = await resolve();
    expect(config.server.host).toBe('localhost');
    expect(config.preview.host).toBe('localhost');
  });

  test('DEV_NO_AUTH=1 で --host（全部のインターフェース）を渡すと起動しない', async () => {
    process.env.DEV_NO_AUTH = '1';
    await expect(resolve({ server: { host: true } })).rejects.toThrow(/DEV_NO_AUTH/);
    await expect(resolve({ server: { host: '0.0.0.0' } })).rejects.toThrow(/DEV_NO_AUTH/);
    await expect(resolve({ server: { host: '192.168.1.50' } })).rejects.toThrow(/DEV_NO_AUTH/);
  });

  test('DEV_NO_AUTH が無ければ今までどおり全部のインターフェースで受ける', async () => {
    delete process.env.DEV_NO_AUTH;
    const config = await resolve();
    // web/.env に DEV_NO_AUTH=1 を書いた手元では localhost になる
    const { devNoAuthEnabled } = await import('../dev-host');
    expect(config.server.host).toBe(devNoAuthEnabled(WEB) ? 'localhost' : true);
  });
});

describe('dev-host.ts: devNoAuthEnabled は shell と .env のどちらかが 1 なら真', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const withEnvFile = (text: string | null) => {
    dir = mkdtempSync(join(tmpdir(), 'fc-244-'));
    if (text !== null) writeFileSync(join(dir, '.env'), text);
    return dir;
  };

  test('.env だけに書いた場合（Worker に届くのはこちら）', async () => {
    const { devNoAuthEnabled } = await import('../dev-host');
    expect(devNoAuthEnabled(withEnvFile('DEV_NO_AUTH=1 # 手元だけ\n'), {})).toBe(true);
  });

  test('shell で 0 を渡しても .env が 1 なら真', async () => {
    const { devNoAuthEnabled } = await import('../dev-host');
    expect(devNoAuthEnabled(withEnvFile('DEV_NO_AUTH="1"\n'), { DEV_NO_AUTH: '0' })).toBe(true);
  });

  test('shell だけに書いた場合', async () => {
    const { devNoAuthEnabled } = await import('../dev-host');
    expect(devNoAuthEnabled(withEnvFile(null), { DEV_NO_AUTH: '1' })).toBe(true);
  });

  test('どちらにも無ければ偽', async () => {
    const { devNoAuthEnabled } = await import('../dev-host');
    expect(devNoAuthEnabled(withEnvFile('OTHER=1\n'), {})).toBe(false);
    expect(devNoAuthEnabled(withEnvFile(null), { DEV_NO_AUTH: '0' })).toBe(false);
  });
});
