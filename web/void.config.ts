import { defineConfig } from 'void/config';

// Claude Town の画面（../src、シンボリックリンク）と、ccn への中継（routes/）を1つの Worker で出す。
// 本番は town.fybe.jp だけ。Cloudflare Access（アプリ claude-town、ポリシー town-owner と town-void-deploy）がホスト名全体を守り、
// middleware/01.access.ts が JWT を確かめ直す。workers.dev とプレビューの URL は出さない。
export default defineConfig({
  target: 'cloudflare',
  inference: { appType: 'void' },
  worker: {
    compatibility_date: '2026-11-01',
    // Access アプリ claude-town の値。秘密ではない
    vars: {
      CF_ACCESS_TEAM_DOMAIN: 'https://fybejp.cloudflareaccess.com',
      CF_ACCESS_AUD: 'cdb45567dfefae6f6b9300aa45f2a9628e27cf0192eba8e40338eb7045f226c5',
    },
  },
  cloudflare: {
    name: 'claude-town',
    account_id: '9b67e2ec0e2cf3359289e1fc860d3777',
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: 'town.fybe.jp', custom_domain: true }],
    observability: { enabled: true },
  },
  routing: { alwaysUseHttps: true },
});
