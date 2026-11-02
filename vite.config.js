import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Relative asset URLs so Electron can open dist/index.html via file://.
  base: './',
  plugins: [react(), tailwindcss()],
  // manifold-3d ships its own WASM binary; prebundling it through
  // esbuild breaks `locateFile` / `import.meta.url` resolution inside
  // the geometry worker.
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
  worker: {
    format: 'es',
  },
  // Paddle Sandbox only accepts checkout requests from these local origins.
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
})
