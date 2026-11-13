import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODULES } from '@/domain/access'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { GUIDE, GUIDE_CONNECTIONS, GUIDE_FLOWS, STATE_MACHINES, guideFlow, guideLinks } from './guide'
import { REPORTS } from './reports'
import { createServices } from './services'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** Route patterns from the router source: shell paths, the phone app under /m, and the slug lists it maps. */
function routes(): string[] {
  const source = read('../app/router.tsx')
  const [shell = '', phone = ''] = source.split("path: 'm',")
  const literal = (text: string) => [...text.matchAll(/path: '([^']+)'/g)].map((m) => m[1] as string)
  const master = [...(source.match(/MASTER_SLUGS = \[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => `master/${m[1]}`)
  const mapped = [...source.matchAll(/\.\.\.\[([^\]]+)\]\.map\(\(slug\) => \(\{ path: `([a-z/]*)\$\{slug\}`/g)].flatMap((m) => [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((s) => `${m[2]}${s[1]}`))
  return ['', 'm', ...literal(shell), ...literal(phone).map((p) => `m/${p}`), ...master, ...mapped].filter((p) => p !== '*')
}

const matches = (link: string, pattern: string) => {
  const a = link.split(/[?#]/)[0]?.replace(/^\//, '').split('/').filter(Boolean) ?? []
  const b = pattern.split('/').filter(Boolean)
  return a.length === b.length && b.every((seg, i) => seg.startsWith(':') || seg === a[i])
}

describe('guide', () => {
  const patterns = routes()

  it('reads the router', () => {
    expect(patterns).toContain('bookings/:id')
    expect(patterns).toContain('m/housekeeping')
    expect(patterns).toContain('finance/cash-in')
    expect(patterns).toContain('master/approval-rules')
  })

  it.each(guideLinks())('links %s to a real route', (link) => {
    expect(patterns.some((p) => matches(link, p))).toBe(true)
  })

  it('covers every permission module', () => {
    for (const m of MODULES) expect(GUIDE.some((e) => e.module === m), m).toBe(true)
  })

  it('names flows and connections that exist', () => {
    const slugs = GUIDE.map((e) => e.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const e of GUIDE) for (const id of e.flows) expect(guideFlow(id), `${e.slug} -> ${id}`).toBeDefined()
    for (const c of GUIDE_CONNECTIONS) {
      expect(slugs, c.from).toContain(c.from)
      expect(slugs, c.to).toContain(c.to)
      for (const id of c.flows) expect(guideFlow(id), id).toBeDefined()
    }
  })

  describe('system details', () => {
    const services = createServices(createMockPorts(fixedClock('2026-10-30'), 0)) as unknown as Record<string, Record<string, unknown>>
    const mock = [read('../infrastructure/mock/index.ts'), read('../infrastructure/mock/cashier.ts'), read('../infrastructure/mock/ledger.ts'), read('../infrastructure/mock/stock.ts'), read('../infrastructure/mock/groups.ts'), read('../infrastructure/mock/messaging.ts'), read('../infrastructure/mock/housekeeping.ts'), read('../infrastructure/mock/restrictions.ts'), read('../infrastructure/mock/guests.ts'), read('../infrastructure/mock/owners.ts'), read('../infrastructure/mock/cityLedger.ts'), read('../infrastructure/mock/enquiries.ts')].join('\n')
    const seed = read('../infrastructure/mock/data/finance.ts')
    const ruleSource = [mock, read('../domain/cashier.ts'), read('./services.ts'), read('./groups.ts'), read('../domain/finance.ts'), read('../domain/serviceOrder.ts'), read('../domain/journal.ts'), read('../domain/stock.ts'), read('../domain/nightAudit.ts'), read('../domain/transactionCode.ts'), read('./messaging.ts'), read('../domain/housekeeping.ts'), read('../domain/owner.ts'), read('./accounting.ts'), read('../domain/cityLedger.ts'), read('../domain/hospitality.ts')].join('\n')
    const slugs = REPORTS.map((r) => r.slug)
    const steps = GUIDE_FLOWS.flatMap((f) => f.steps.map((s) => ({ flow: f.id, step: s })))

    it.each(steps.map(({ flow, step }) => [`${flow}: ${step.title}`, step] as const))('%s', (_name, step) => {
      const sys = step.system
      expect(sys, 'every step explains its system side').toBeDefined()
      if (!sys) return
      const [group = '', method = ''] = sys.useCase.split('.')
      expect(typeof services[group]?.[method], sys.useCase).toBe('function')
      for (const r of sys.reports ?? []) expect(slugs, r).toContain(r)
      for (const l of sys.ledger ?? []) expect(seed, l.categoryId).toContain(`cat('${l.categoryId}', '${l.category}'`)
      if (sys.audit) expect(mock, `${sys.audit.entity}`).toMatch(new RegExp(`log\\([^\\n]*'${sys.audit.entity}'`))
      for (const r of sys.refusals ?? []) expect(ruleSource, r.code).toContain(`'${r.code}'`)
    })
  })

  it('builds the state machines from the domain tables', () => {
    for (const m of STATE_MACHINES) {
      const ids = m.states.map((s) => s.id)
      for (const t of m.transitions) {
        expect(ids, `${m.id} ${t.from}`).toContain(t.from)
        expect(ids, `${m.id} ${t.to}`).toContain(t.to)
      }
    }
    expect(STATE_MACHINES.find((m) => m.id === 'transaction')?.transitions).toContainEqual({ from: 'submitted', to: 'rejected' })
  })
})
