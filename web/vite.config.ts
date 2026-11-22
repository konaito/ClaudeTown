import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { voidPlugin } from "void";
import { devNoAuthEnabled, refuseExposedNoAuth } from "./dev-host.ts";

// web/.env に DEV_NO_AUTH=1 があると middleware/01.access.ts が Access の確認を飛ばすので、そのときは localhost だけで受ける（#244）
const noAuth = devNoAuthEnabled(fileURLToPath(new URL(".", import.meta.url)));
const host = noAuth ? "localhost" : true;

// Claude Town の画面（../src、../index.html、../public へのシンボリックリンク）と、ccn への中継（routes/）を1つの Worker で出す
export default defineConfig({
  plugins: [react(), voidPlugin(), refuseExposedNoAuth(noAuth)],
  // index.html、src、public はシンボリックリンクなので、実体のパスに直さない（直すと出力のファイル名が ../index.html になる）
  resolve: { preserveSymlinks: true },
  server: { host, port: 5174, strictPort: false },
  preview: { host },
});
