// Loads TypeScript modules from the front end through Vite's SSR loader, so the `@/` alias and
// extensionless imports resolve exactly as they do in the app. No tsx needed.
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export async function withModules(paths, use) {
  const server = await createServer({
    root: repoRoot,
    configFile: `${repoRoot}vite.config.ts`,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    const modules = await Promise.all(paths.map((p) => server.ssrLoadModule(p)))
    return await use(...modules)
  } finally {
    await server.close()
  }
}
