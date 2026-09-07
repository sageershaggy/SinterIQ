import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    fs: {
      strict: true,
      deny: [
        '**/.env*',
        '**/*.db*',
        '**/.*key*',
        '**/.*secret*',
        '**/server/**',
        '**/data/**',
        '**/docs/**',
        '**/tests/**',
        '**/*.pem',
      ],
    },
  },
});
