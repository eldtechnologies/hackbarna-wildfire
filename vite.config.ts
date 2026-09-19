import { defineConfig } from 'vite';
import viteCesium from 'vite-plugin-cesium';
import { SERVER_PORT } from './server/config';

export default defineConfig({
  plugins: [viteCesium()],
  server: {
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${SERVER_PORT}`,
    },
  },
});
