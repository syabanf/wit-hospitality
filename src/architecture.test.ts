/**
 * Clean-architecture guard: imports only point inward.
 *   lib            <- everyone (pure helpers, imports nothing internal)
 *   domain         <- application, infrastructure, presentation
 *   application    <- infrastructure (ports), presentation (services), app
 *   infrastructure <- app only
 *   presentation   <- app only
 * Domain and application stay free of React so they run in node and on a server.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))
type Layer = 'lib' | 'domain' | 'application' | 'infrastructure' | 'presentation' | 'app' | 'styles' | 'root'

const ALLOWED: Record<Layer, readonly Layer[]> = {
  lib: [],
  domain: ['lib'],
  application: ['lib', 'domain'],
  infrastructure: ['lib', 'domain', 'application'],
  presentation: ['lib', 'domain', 'application'],
  app: ['lib', 'domain', 'application', 'infrastructure', 'presentation'],
  styles: [],
  root: ['app', 'styles'],
}
const NO_REACT: readonly Layer[] = ['lib', 'domain', 'application', 'infrastructure']

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : []
  })
}

const layerOf = (path: string): Layer => {
  const top = relative(SRC, path).split('/')[0] ?? ''
  return (top.includes('.') ? 'root' : top) as Layer
}

describe('architecture', () => {
  for (const file of files(SRC)) {
    const from = layerOf(file)
    it(`${relative(SRC, file)} imports only inward`, () => {
      const source = readFileSync(file, 'utf8')
      const specs = [...source.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
        (m) => (m[1] ?? m[2]) as string,
      )
      for (const spec of specs) {
        if (spec.startsWith('@/') || spec.startsWith('.')) {
          const target = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : resolve(dirname(file), spec)
          const to = layerOf(target)
          if (to === from) continue
          expect(ALLOWED[from], `${relative(SRC, file)} -> ${spec}`).toContain(to)
        } else if (NO_REACT.includes(from)) {
          expect(spec, `${relative(SRC, file)} must not depend on ${spec}`).not.toMatch(/^react/)
        }
      }
    })
  }
})
