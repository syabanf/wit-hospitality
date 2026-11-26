import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Agent worktrees under .claude/ are full copies of the repo; without these the dependency
  // scan reads every copy's index.html and the watcher follows every copy's files.
  optimizeDeps: { entries: ['index.html'] },
  server: { watch: { ignored: ['**/.claude/**', '**/api/**'] } },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
