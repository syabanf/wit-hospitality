// Writes DEFAULT_PERMISSIONS from src/domain/access.ts as JSON. The Go rbac snapshot test compares
// its own matrix with this file, so a change on either side fails the build until both agree.
// Run: node api/scripts/export-permissions.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withModules } from './vite-load.mjs'

const out = fileURLToPath(new URL('../internal/platform/rbac/testdata/default_permissions.json', import.meta.url))

await withModules(['/src/domain/access.ts'], (access) => {
  const snapshot = {
    roles: access.ROLES,
    modules: access.MODULES,
    actions: access.ACTIONS,
    roleLabels: access.ROLE_LABEL,
    moduleLabels: access.MODULE_LABEL,
    permissions: access.DEFAULT_PERMISSIONS,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`wrote ${out}`)
})
