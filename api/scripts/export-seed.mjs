// Builds the mock adapter's demo state with the front end's own seed builders and writes the
// identity, property, people and payroll slices to api/seed/*.json for cmd/seed. Dates are absolute for the
// base date written into each file; cmd/seed shifts them so the demo always starts today.
// Run: node api/scripts/export-seed.mjs [YYYY-MM-DD]
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { withModules } from './vite-load.mjs'

const baseDate = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const out = (name) => fileURLToPath(new URL(`../seed/${name}`, import.meta.url))
const write = (name, value) => {
  writeFileSync(out(name), `${JSON.stringify(value, null, 2)}\n`)
  console.log(`wrote ${out(name)}`)
}

await withModules(['/src/infrastructure/mock/state.ts', '/src/infrastructure/mock/data/access.ts'], (state, access) => {
  const s = state.buildState(baseDate)
  write('identity.json', {
    baseDate,
    demoPassword: access.DEMO_PASSWORD,
    users: s.users,
    permissions: s.permissions,
    preferences: s.preferences,
    audit: s.audit,
  })
  write('property.json', {
    baseDate,
    locations: s.locations,
    villas: s.villas,
    groups: s.groups,
    units: s.units,
    ratePlans: s.ratePlans,
    blocks: s.blocks,
  })
  const next = (keys) => Object.fromEntries(keys.map((k) => [k, s.next[k] ?? 1]))
  write('people.json', {
    baseDate,
    employees: s.employees,
    shifts: s.shifts,
    assignments: s.assignments,
    attendance: s.attendance,
    leaves: s.leaves,
    overtime: s.overtime,
    loans: s.loans,
    announcements: s.announcements,
    kpis: s.kpis,
    next: next(['employee', 'assignment', 'attendance', 'leave', 'overtime', 'loan', 'announcement', 'kpi']),
  })
  write('payroll.json', {
    baseDate,
    settings: s.payrollSettings,
    periods: s.periods,
    next: next(['adjustment']),
  })
})
