import { useState } from 'react'
import { Link } from 'react-router'
import { Check, CircleAlert, FlaskConical, Play, PlayCircle, RotateCcw, UserRound } from 'lucide-react'
import { actAs, emptyContext, SCENARIOS, type Scenario, type SimContext, type SimSummary, type StepResult } from '@/application/simulation'
import { TRANSACTION_STATUS_LABEL, type TransactionStatus } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'
import { TRANSACTION_TONE } from '../shared/tones'

type StepState = { status: 'idle' | 'running' | 'done' | 'error'; result?: StepResult; error?: string }

interface Run {
  ctx: SimContext
  snapshot: string | null
  steps: Record<string, StepState>
  summary: SimSummary | null
}

const fresh = (): Run => ({ ctx: emptyContext(), snapshot: null, steps: {}, summary: null })

/** Simulasi alur keuangan: every step runs the real use cases as the person who would do it. */
export default function SimulationPage() {
  const services = useServices()
  const { user, reload } = useAccess()
  const toast = useToast()
  const [scenarioId, setScenarioId] = useState<Scenario['id']>('booking')
  const [runs, setRuns] = useState<Record<Scenario['id'], Run>>({ booking: fresh(), repair: fresh() })
  const [busy, setBusy] = useState(false)
  const scenario = SCENARIOS.find((x) => x.id === scenarioId) ?? (SCENARIOS[0] as Scenario)
  const run = runs[scenario.id]
  const home = user.email.split('@')[0] ?? 'rama'
  const nextIndex = scenario.steps.findIndex((st) => run.steps[st.id]?.status !== 'done')
  const patch = (next: Partial<Run>, steps?: Record<string, StepState>) =>
    setRuns((all) => ({ ...all, [scenario.id]: { ...all[scenario.id], ...next, steps: { ...all[scenario.id].steps, ...steps } } }))

  /** Runs one step; `ctx` is shared by reference so the next step sees what this one created. */
  async function runStep(index: number) {
    const step = scenario.steps[index]
    if (!step) return false
    if (index === 0 && !run.snapshot) patch({ snapshot: await services.demo.snapshot() })
    patch({}, { [step.id]: { status: 'running' } })
    try {
      await actAs(services, step.actor)
      const result = await step.run(services, run.ctx)
      const summary = index === scenario.steps.length - 1 ? await scenario.summary(services, run.ctx) : null
      patch(summary ? { summary } : {}, { [step.id]: { status: 'done', result } })
      return true
    } catch (error) {
      patch({}, { [step.id]: { status: 'error', error: error instanceof Error ? error.message : String(error) } })
      return false
    } finally {
      await actAs(services, home)
    }
  }

  async function runAll() {
    setBusy(true)
    for (let i = Math.max(0, nextIndex); i < scenario.steps.length; i++) {
      const ok = await runStep(i)
      if (!ok) break
    }
    setBusy(false)
    reload()
  }

  async function reset() {
    setBusy(true)
    try {
      if (run.snapshot) await services.demo.restore(run.snapshot)
      await actAs(services, home)
      setRuns((all) => ({ ...all, [scenario.id]: fresh() }))
      toast({ title: 'Simulation reset', description: 'The demo data is back to where it was before the first step.' })
      reload()
    } finally {
      setBusy(false)
    }
  }

  if (!services.demo.available) {
    return (
      <Card>
        <p className="flex items-start gap-2 text-sm">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          The simulation runs on demo data only. This console talks to the live API, so it is switched off here.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">Simulasi alur keuangan. Each step calls the same use cases a person would, signed in as that person, so you can follow every rupiah from a booking or a repair into the books. Reset puts the demo back.</p>
        <Tabs label="Scenario" options={SCENARIOS.map((x) => ({ value: x.id, label: x.title }))} value={scenarioId} onChange={setScenarioId} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card aria-labelledby="sim-steps">
          <CardHeader
            id="sim-steps"
            title={scenario.title}
            icon={<FlaskConical aria-hidden className="size-5 text-accent" />}
            action={
              <>
                <Button variant="soft" size="sm" disabled={busy || !run.snapshot} onClick={() => void reset()}>
                  <RotateCcw aria-hidden className="size-3.5" /> Reset simulation
                </Button>
                <Button variant="accent" size="sm" loading={busy} disabled={nextIndex === -1} onClick={() => void runAll()}>
                  <PlayCircle aria-hidden className="size-3.5" /> Run all
                </Button>
              </>
            }
          />
          <p className="mb-4 text-sm text-muted">{scenario.blurb}</p>
          <ol className="stagger space-y-3">
            {scenario.steps.map((st, i) => {
              const state = run.steps[st.id] ?? { status: 'idle' as const }
              return (
                <li key={st.id} className={cn('rounded-panel border p-4 transition-colors', state.status === 'done' ? 'border-line bg-raised' : state.status === 'error' ? 'border-danger bg-danger-soft' : 'border-line-strong')}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={cn('grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold', state.status === 'done' ? 'bg-success-soft text-success' : i === nextIndex ? 'bg-invert text-on-invert' : 'bg-control text-muted')}>
                      {state.status === 'done' ? <Check aria-hidden className="size-4" strokeWidth={3} /> : i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{st.title}</span>
                      <span className="flex items-center gap-1 text-xs text-muted">
                        <UserRound aria-hidden className="size-3" /> {st.actorLabel}
                      </span>
                    </span>
                    <Button size="sm" variant={i === nextIndex ? 'solid' : 'soft'} loading={state.status === 'running'} disabled={busy || i !== nextIndex} onClick={() => void (async () => {
                      setBusy(true)
                      await runStep(i)
                      setBusy(false)
                      reload()
                    })()}>
                      <Play aria-hidden className="size-3.5" /> Run
                    </Button>
                  </div>
                  {state.result && (
                    <div className="mt-3 animate-rise space-y-1 pl-11 text-sm">
                      {state.result.lines.map((l) => (
                        <p key={l} className="break-words text-body">{l}</p>
                      ))}
                      <p className="flex flex-wrap gap-x-3 pt-1">
                        {state.result.links.map((l) => (
                          <Link key={l.to} to={l.to} className="text-accent-text hover:underline">
                            {l.label}
                          </Link>
                        ))}
                      </p>
                    </div>
                  )}
                  {state.error && <p role="alert" className="mt-2 pl-11 text-sm font-medium text-danger">{state.error}</p>}
                </li>
              )
            })}
          </ol>
        </Card>
        <div className="space-y-4">
          <Card aria-labelledby="sim-trail">
            <CardHeader id="sim-trail" title="Money trail" />
            {!run.summary ? (
              <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Run every step to see where the money went.</p>
            ) : (
              <div className="animate-pop-in space-y-4">
                <DataTable
                  label="Money trail"
                  rows={run.summary.trail}
                  rowKey={(r) => r.transactionId}
                  columns={[
                    { key: 's', header: 'Step', cell: (r) => <Link to={`/finance/transactions/${r.transactionId}`} className="hover:underline">{r.step}<span className="block font-mono text-xs text-muted">{r.number}</span></Link> },
                    { key: 'a', header: 'Account', cell: (r) => <span className="text-xs">{r.account}</span> },
                    { key: 'st', header: 'Status', cell: (r) => <StatusPill tone={TRANSACTION_TONE[r.status as TransactionStatus]}>{TRANSACTION_STATUS_LABEL[r.status as TransactionStatus]}</StatusPill> },
                    { key: 'm', header: 'Amount', align: 'right', cell: (r) => <span className={cn('font-semibold', r.amount < 0 && 'text-muted')}>{r.amount < 0 ? '-' : '+'}{money(Math.abs(r.amount))}</span> },
                  ]}
                />
                <DataTable
                  label="Balances before and after"
                  rows={run.summary.balances}
                  rowKey={(b) => b.accountId}
                  columns={[
                    { key: 'a', header: 'Account', cell: (b) => b.account },
                    { key: 'b', header: 'Before', align: 'right', cell: (b) => money(b.before) },
                    { key: 'f', header: 'After', align: 'right', cell: (b) => money(b.after) },
                    { key: 'd', header: 'Change', align: 'right', cell: (b) => <Tag tone={b.after - b.before >= 0 ? 'success' : 'accent'}>{b.after - b.before >= 0 ? '+' : '-'}{money(Math.abs(b.after - b.before))}</Tag> },
                  ]}
                />
              </div>
            )}
          </Card>
          {run.summary && (
            <Card aria-labelledby="sim-books" className="animate-pop-in">
              <CardHeader id="sim-books" title="In the books" />
              <dl className="space-y-3 text-sm">
                {run.summary.facts.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-muted">{k}</dt>
                    <dd className="font-medium break-words">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {run.summary.links.map((l) => (
                  <Link key={l.to} to={l.to} className="text-accent-text hover:underline">
                    {l.label}
                  </Link>
                ))}
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
