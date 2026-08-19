import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3005,
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:4005',
        changeOrigin: true,
        timeout: 3600000,
        cookieDomainRewrite: '',
      },
      '/dev': {
        target: 'http://localhost:4005',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4005',
        ws: true,
      },
    },
  },
});
