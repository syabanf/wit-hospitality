// Compares every call in src/infrastructure/http/index.ts with the routes the Go monolith registers
// and prints implemented and missing calls per owning context.
//   node api/scripts/contract.mjs              # table; exits 1 if a built context misses a call
//   node api/scripts/contract.mjs --markdown   # the ownership table for docs/ARCHITECTURE.md
//   node api/scripts/contract.mjs --routes routes.json   # use a saved route list instead of go run
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONTEXTS, ownerOf } from './ownership.mjs'

const apiDir = fileURLToPath(new URL('..', import.meta.url))
const adapter = fileURLToPath(new URL('../../src/infrastructure/http/index.ts', import.meta.url))
const args = process.argv.slice(2)
const markdown = args.includes('--markdown')
const routesFile = args.includes('--routes') ? args[args.indexOf('--routes') + 1] : null

/** Drops a query string, ignoring a `?` inside a `${...}` expression. */
function stripQuery(template) {
  let depth = 0
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith('${', i)) depth++
    else if (template[i] === '}' && depth > 0) depth--
    else if (template[i] === '?' && depth === 0) return template.slice(0, i)
  }
  return template
}

/** Every http.<verb>(path) call with its port and method, paths expanded to concrete templates. */
export function parseAdapter(source) {
  const maps = {}
  for (const m of source.matchAll(/const (\w+_ACTION) = \{([^}]*)\}/g)) {
    maps[m[1]] = [...m[2].matchAll(/:\s*'([^']+)'/g)].map((x) => x[1])
  }
  const calls = []
  let port = '?'
  let method = '?'
  source.split('\n').forEach((line, i) => {
    const portMatch = /^ {4}(\w+): \{$/.exec(line)
    if (portMatch) port = portMatch[1]
    const methodMatch = /^ {6}(\w+): /.exec(line)
    if (methodMatch) method = methodMatch[1]
    for (const m of line.matchAll(/http\.(get|post|patch|put|delete|upload)(?:<[^>]*>)?\(\s*(['`])(.*?)\2/g)) {
      const verb = m[1] === 'upload' ? 'POST' : m[1].toUpperCase()
      const raw = stripQuery(m[3])
      const segments = raw.split('/').map((seg) => {
        const expr = /^\$\{(.*)\}$/.exec(seg)?.[1]
        if (expr === undefined) return [seg]
        const lookup = /^(\w+_ACTION)\[\w+\]$/.exec(expr)
        if (lookup) return maps[lookup[1]] ?? ['{}']
        if (expr.includes('?')) return [...expr.matchAll(/[?:]\s*'([^']+)'/g)].map((x) => x[1])
        return ['{}']
      })
      const paths = segments.reduce((acc, options) => acc.flatMap((p) => options.map((o) => (p ? `${p}/${o}` : o))), [''])
      calls.push({ line: i + 1, port, method, verb, template: raw, paths })
    }
  })
  return calls
}

function goRoutes() {
  const raw = routesFile ? readFileSync(routesFile, 'utf8') : execFileSync('go', ['run', './cmd/monolith', '-routes'], { cwd: apiDir, encoding: 'utf8' })
  const set = new Set()
  for (const r of JSON.parse(raw)) {
    if (!r.pattern.startsWith('/api/v1/')) continue
    set.add(`${r.method} ${r.pattern.slice('/api/v1/'.length).replace(/\{[^}]+\}/g, '{}')}`)
  }
  return set
}

const calls = parseAdapter(readFileSync(adapter, 'utf8'))
const routes = markdown ? new Set() : goRoutes()
const stats = Object.fromEntries(CONTEXTS.map((c) => [c.name, { calls: 0, endpoints: new Set(), implemented: new Set(), missing: [] }]))
const unowned = []
for (const call of calls) {
  const owners = new Set(call.paths.map(ownerOf))
  if (owners.has(null)) {
    unowned.push(call)
    continue
  }
  const owner = [...owners][0]
  const s = stats[owner]
  s.calls++
  for (const p of call.paths) {
    const key = `${call.verb} ${p}`
    s.endpoints.add(key)
    if (routes.has(key)) s.implemented.add(key)
    else if (!s.missing.some((x) => x.key === key)) s.missing.push({ key, at: `${call.port}.${call.method} (index.ts:${call.line})` })
  }
}

if (markdown) {
  console.log('| Context | Phase | Calls | Endpoints | Owns |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const c of CONTEXTS) console.log(`| ${c.name} | ${c.phase} | ${stats[c.name].calls} | ${stats[c.name].endpoints.size} | ${c.summary} |`)
  console.log(`| **total** | | **${calls.length}** | **${Object.values(stats).reduce((n, s) => n + s.endpoints.size, 0)}** | |`)
  console.log('\nEvery endpoint, by owner:\n')
  for (const c of CONTEXTS) console.log(`- **${c.name}**: ${[...stats[c.name].endpoints].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1])).map((e) => '`' + e + '`').join(', ')}`)
  process.exit(0)
}

const pad = (v, n) => String(v).padEnd(n)
console.log(`${pad('context', 14)}${pad('phase', 7)}${pad('calls', 7)}${pad('endpoints', 11)}${pad('implemented', 13)}missing`)
let totalEndpoints = 0
let totalImplemented = 0
for (const c of CONTEXTS) {
  const s = stats[c.name]
  totalEndpoints += s.endpoints.size
  totalImplemented += s.implemented.size
  console.log(`${pad(c.name, 14)}${pad(c.phase, 7)}${pad(s.calls, 7)}${pad(s.endpoints.size, 11)}${pad(s.implemented.size, 13)}${s.missing.length}`)
}
console.log(`${pad('total', 14)}${pad('', 7)}${pad(calls.length, 7)}${pad(totalEndpoints, 11)}${pad(totalImplemented, 13)}${totalEndpoints - totalImplemented}`)
if (unowned.length) {
  console.log('\nCalls without an owner (add a rule to scripts/ownership.mjs):')
  for (const u of unowned) console.log(`  ${u.verb} ${u.template}  ${u.port}.${u.method} (index.ts:${u.line})`)
}
let failed = unowned.length > 0
// A context counts as built once the monolith serves any of its endpoints; then it must serve all.
for (const c of CONTEXTS.filter((x) => x.phase === 0 || stats[x.name].implemented.size > 0)) {
  const s = stats[c.name]
  if (s.missing.length) {
    failed = true
    console.log(`\n${c.name} misses:`)
    for (const m of s.missing) console.log(`  ${m.key}  ${m.at}`)
  } else console.log(`\n${c.name}: all ${s.endpoints.size} endpoints implemented`)
}
const extras = [...routes].filter((r) => !Object.values(stats).some((s) => s.endpoints.has(r)))
if (extras.length) console.log(`\nGo routes outside the TS contract: ${extras.join(', ')}`)
process.exit(failed ? 1 : 0)
