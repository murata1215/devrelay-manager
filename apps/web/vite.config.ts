// Vite 設定（サイクル1.18 ④-2: apps/web 最小 SPA）。
// React プラグインのみを使う。プロキシは使わない — server 側の CORS が
// 全開（@fastify/cors をデフォルト登録）のため不要。
// サイクル1.23: Tailwind 4 は @tailwindcss/vite 経由で導入する（PostCSS 設定ファイルは作らない）。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
