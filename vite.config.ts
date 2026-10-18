import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/.toolchain/**'] },
  },
  clearScreen: false,
  build: { target: ['es2022', 'chrome110', 'safari16'] },
});
