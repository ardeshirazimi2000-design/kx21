import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Socket.IO of the communications module (WebSocket); must come before the general /api rule.
      '/api/realtime': { target: 'http://localhost:4100', ws: true },
      '/api': 'http://localhost:4100',
    },
  },
});
