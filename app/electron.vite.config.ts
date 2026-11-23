import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'electron/main.ts'), formats: ['es']},
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // A sandboxed preload cannot be an ES module: build one CommonJS file.
      lib: { entry: resolve(__dirname, 'electron/preload.ts'), formats: ['cjs']},
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    plugins: [react(), tailwindcss()],
  },
})
