// Vite 設定（サイクル1.18 ④-2: apps/web 最小 SPA）。
// React プラグインのみを使う。プロキシは使わない — ローカル開発は
// apps/web/.env.development の VITE_API_BASE + server 側 CORS_ORIGINS で疎通する
// （サイクル1.27。本番は apps/web/dist を server が同一オリジンで静的配信する）。
// サイクル1.23: Tailwind 4 は @tailwindcss/vite 経由で導入する（PostCSS 設定ファイルは作らない）。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
