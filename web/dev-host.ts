// 手元の開発サーバーで Access の確認を飛ばす（DEV_NO_AUTH=1）ときに、開発サーバーを loopback だけで受けさせる（#244）。
// Worker から見える Host と CF-Connecting-IP では、LAN の別の機械からの要求を見分けられない。
// Host は要求の側が好きに付けられる。CF-Connecting-IP は vite のプロセスから miniflare に渡すので、LAN から来ても 127.0.0.1 になり、
// 要求に付いていればその値が残る（どちらも 2026-11-23 に実測）。そこで、要求を受ける口そのものを loopback に絞る。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { Plugin } from 'vite';

// Worker の DEV_NO_AUTH は web/.env から届く（shell の値は届かない）。安全な側に倒すため、shell と .env のどちらかが 1 なら真にする
export function devNoAuthEnabled(dir: string, processEnv: Record<string, string | undefined> = process.env): boolean {
  if (processEnv.DEV_NO_AUTH === '1') return true;
  const file = join(dir, '.env');
  return existsSync(file) && parseEnv(readFileSync(file, 'utf8')).DEV_NO_AUTH === '1';
}

// vite の host の値で loopback だけを指すもの。undefined と false は vite の既定（localhost）
export function isLoopbackHost(host: string | boolean | undefined): boolean {
  if (host === undefined || host === false) return true;
  if (host === true) return false;
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

// --host などで loopback の外を指したまま DEV_NO_AUTH=1 で起動しようとしたら止める
export function refuseExposedNoAuth(enabled: boolean): Plugin {
  return {
    name: 'claude-town:dev-no-auth-loopback',
    configResolved(config) {
      if (!enabled) return;
      const exposed = [
        ['server.host', config.server.host],
        ['preview.host', config.preview.host],
      ].filter(([, host]) => !isLoopbackHost(host as string | boolean | undefined));
      if (exposed.length === 0) return;
      const list = exposed.map(([key, host]) => `${key}=${String(host)}`).join(', ');
      throw new Error(`DEV_NO_AUTH=1 では開発サーバーを loopback の外で受けない（${list}）。--host を外すか、web/.env の DEV_NO_AUTH を消す（#244）`);
    },
  };
}
