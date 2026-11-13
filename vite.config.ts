import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP headers unlock the multi-threaded (pthread) DuckDB-WASM build.
// The app also falls back to the single-threaded EH build when headers are absent.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: coiHeaders, fs: { strict: false } },
  preview: { headers: coiHeaders },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
});
