// 試験用の起動。ccn のコードは変えず、buildDeps の結果のうち次だけを差し替える。
// 1) 登録簿を2ノードの StaticRegistry にし、中継に試験用のサービストークンを渡す（設定に peers の欄が無いため）。
// 2) 同じ機械で ~/.claude/projects を共有するので、別の機械を模すため、履歴と teleport の SDK 呼び出しに
//    dir（この町の proj）を既定で渡し、端末の一覧（claude agents）を空にする。
import { listSessions, getSessionMessages, getSessionInfo, importSessionToStore, forkSession, deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "/tmp/ccn-tp-test/src/config";
import { buildDeps } from "/tmp/ccn-tp-test/src/main";
import { createApp } from "/tmp/ccn-tp-test/src/api/app";
import { History } from "/tmp/ccn-tp-test/src/engine/history";
import { StaticRegistry } from "/tmp/ccn-tp-test/src/registry/registry";
import { Relay } from "/tmp/ccn-tp-test/src/relay/relay";

const cfgPath = process.argv[2]!;
const dir = process.env.TP_DIR!;
const cfg = loadConfig(cfgPath);
const peers = JSON.parse(process.env.TP_PEERS!) as { name: string; url: string }[];
const deps = buildDeps(cfg, cfgPath) as any;
const registry = new StaticRegistry(peers.map((p) => ({ name: p.name, url: p.url, status: "healthy" as const, self: p.name === cfg.name })));
deps.registry = registry;
deps.relay = new Relay({ registry, nodeName: cfg.name, serviceToken: { clientId: "tp", clientSecret: "tp" } });
const d = (o?: any) => ({ dir, ...(o ?? {}) });
const fns = {
  listSessions: (o?: any) => listSessions(d(o)),
  getSessionMessages: (id: string, o?: any) => getSessionMessages(id, d(o)),
  getSessionInfo: (id: string, o?: any) => getSessionInfo(id, d(o)),
  importSessionToStore: (id: string, s: any, o?: any) => importSessionToStore(id, s, d(o)),
  forkSession: (id: string, o?: any) => forkSession(id, d(o)),
  deleteSession: (id: string, o?: any) => deleteSession(id, d(o)),
};
deps.history = new History(fns as any);
deps.agents = async () => [];
deps.teleport.fns = { importSessionToStore: fns.importSessionToStore, forkSession: fns.forkSession, deleteSession: fns.deleteSession, getSessionInfo: fns.getSessionInfo };
const app = createApp(deps);
Bun.serve({ hostname: "127.0.0.1", port: cfg.port, fetch: app.fetch, idleTimeout: 0 });
console.log(`tp node ${cfg.name} on ${cfg.port} dir=${dir} pid=${process.pid}`);
