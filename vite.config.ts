import { defineConfig } from 'vite';
import viteCesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [viteCesium()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
