import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development, Vite runs on its own port (5173) and proxies API + WS
// to the hive server (default 7777). In production, the dashboard is built
// to apps/dashboard/dist/ and served directly by the hive server as static
// files at the root path.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:7777',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://localhost:7777',
        ws: true,
      },
    },
  },
  build: {
    // Emit to apps/dashboard/dist (default). The server serves this dir
    // as static when present.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
