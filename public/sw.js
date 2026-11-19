// Claude Town の Service Worker。ホーム画面に追加するためだけのもので、何もキャッシュしない。
// fetch は respondWith を呼ばないので、API、SSE、Access のリダイレクトはすべて今までどおりネットワークに行く（ccn の src/web/pwa.ts と同じ作り）
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
