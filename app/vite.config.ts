import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// L'application compilée (dist/) est mise DANS les deux versions de Synapse : l'application Windows (desktop/) et
// l'application Android (android/). Elle est servie depuis l'appareil lui-même, jamais depuis Internet.
// `npm run dev` : un aperçu dans le navigateur, pour le développement seulement.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true },
  build: { chunkSizeWarningLimit: 2000 },
});
