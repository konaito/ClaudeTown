import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { voidPlugin } from "void";

// Claude Town の画面（../src、../index.html、../public へのシンボリックリンク）と、ccn への中継（routes/）を1つの Worker で出す
export default defineConfig({
  plugins: [react(), voidPlugin()],
  // index.html、src、public はシンボリックリンクなので、実体のパスに直さない（直すと出力のファイル名が ../index.html になる）
  resolve: { preserveSymlinks: true },
  server: { host: true, port: 5174, strictPort: false },
});
