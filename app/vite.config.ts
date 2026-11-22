import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 5173 belongs to the desktop launcher (scripts/synapse.mjs); the dev server stays out of its way
  server: { port: 5174, strictPort: true },
  build: { chunkSizeWarningLimit: 2000 },
});
