import { useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRight, ChevronDown, Cpu, GitBranch } from 'lucide-react'
import { ROLE_LABEL, ROLES, type Role } from '@/domain/access'
import { ORIGIN_LABEL } from '@/domain/finance'
import { ACTOR_LABEL, type GuideActor, type GuideFlow, type GuideStep, type StateMachine, type StepSystem } from '@/application/guide'
import { REPORTS } from '@/application/reports'
import { cn } from '@/lib/cn'
import { Dot, Tag, type Tone } from '../../ui/Badge'
import { Card, CardHeader } from '../../ui/Card'

const actorLabel = (a: GuideActor) => ((ROLES as readonly string[]).includes(a) ? ROLE_LABEL[a as Role] : ACTOR_LABEL[a as 'guest' | 'system'])

export function RoleTags({ roles }: { roles: readonly Role[] }) {
  if (roles.length === 0) return <span className="text-xs text-muted">No role by default</span>
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Tag key={r} tone="neutral">
          {ROLE_LABEL[r]}
        </Tag>
      ))}
    </span>
  )
}

const REPORT_TITLE = new Map(REPORTS.map((r) => [r.slug, r.title]))
const BRANCH_TONE: Record<'danger' | 'warning' | 'info', Tone> = { danger: 'danger', warning: 'warning', info: 'info' }

function SystemPanel({ step, system }: { step: GuideStep; system: StepSystem }) {
  const rows: Array<[string, ReactNode]> = [['Use case', <code key="u" className="rounded bg-raised px-1.5 py-0.5 text-xs">services.{system.useCase}</code>]]
  if (system.records?.length) rows.push(['Records', <ul key="r" className="space-y-1">{system.records.map((r) => <li key={r.record}><span className="font-medium">{r.record}</span>: {r.change}</li>)}</ul>])
  if (system.ledger?.length)
    rows.push([
      'Ledger',
      <ul key="l" className="space-y-1">
        {system.ledger.map((l) => (
          <li key={l.categoryId}>
            <Tag tone={l.kind === 'cash_in' ? 'success' : 'danger'}>{l.kind === 'cash_in' ? 'Cash in' : 'Cash out'}</Tag> {l.category} in {l.account}, origin {ORIGIN_LABEL[l.origin]}, {l.status.toLowerCase()}
          </li>
        ))}
      </ul>,
    ])
  if (system.approval) rows.push(['Approval', system.approval])
  if (system.audit) rows.push(['Audit', `${system.audit.action} on ${system.audit.entity}, with who, when and the before and after values`])
  if (system.refusals?.length)
    rows.push([
      'Refused when',
      <ul key="x" className="space-y-1">
        {system.refusals.map((r) => (
          <li key={r.code}>
            <code className="text-xs text-danger">{r.code}</code> {r.when}
          </li>
        ))}
      </ul>,
    ])
  if (system.reports?.length)
    rows.push([
      'Reports',
      <span key="p" className="flex flex-wrap gap-x-3 gap-y-1">
        {system.reports.map((slug) => (
          <Link key={slug} to={`/reports/${slug}`} className="text-info-text underline-offset-2 hover:underline">
            {REPORT_TITLE.get(slug) ?? slug}
          </Link>
        ))}
      </span>,
    ])
  if (system.tiles?.length) rows.push(['Dashboard', system.tiles.join(', ')])
  return (
    <div className="animate-rise rounded-panel bg-raised p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Cpu aria-hidden className="size-4 text-muted" />
        System: {step.title}
      </p>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** A flow as numbered steps: a row with scrolling on desktop, a column on the phone. Each step opens its system detail below. */
export function FlowDiagram({ flow }: { flow: GuideFlow }) {
  const [open, setOpen] = useState<number | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const step = open === null ? null : flow.steps[open]

  function toggle(i: number) {
    setOpen((cur) => (cur === i ? null : i))
    // Desktop shows the panel under the row; bring it into view.
    if (window.matchMedia('(min-width: 1024px)').matches) requestAnimationFrame(() => panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  return (
    <Card aria-labelledby={`flow-${flow.id}`}>
      <CardHeader id={`flow-${flow.id}`} title={flow.title} icon={<GitBranch aria-hidden className="size-5 text-muted" />} />
      <p className="-mt-2 mb-4 max-w-2xl text-sm text-muted">{flow.summary}</p>
      <ol className="stagger flex flex-col gap-3 lg:flex-row lg:overflow-x-auto lg:pb-2">
        {flow.steps.map((s, i) => (
          <li key={s.title} className="flex flex-col lg:flex-row lg:items-stretch">
            <div className={cn('flex min-w-0 flex-col rounded-panel border border-line bg-card p-4 transition-colors lg:w-60 lg:shrink-0', open === i && 'border-line-strong bg-raised')}>
              <span className="flex items-center gap-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-on-ink tabular">{i + 1}</span>
                <span className="text-xs font-medium text-muted">{actorLabel(s.actor)}</span>
              </span>
              <span className="mt-2 font-semibold">{s.title}</span>
              <span className="mt-1 text-sm text-muted">{s.detail}</span>
              {s.branches && (
                <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
                  {s.branches.map((b) => (
                    <li key={b.label} className="flex gap-2 text-xs">
                      <Dot tone={BRANCH_TONE[b.tone]} className="mt-1" />
                      <span>
                        {b.to ? (
                          <Link to={b.to} className="font-medium hover:underline">
                            {b.label}
                          </Link>
                        ) : (
                          <span className="font-medium">{b.label}</span>
                        )}
                        <span className="text-muted">: {b.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-xs">
                {s.to && (
                  <Link to={s.to} className="inline-flex items-center gap-1 font-medium text-info-text hover:underline">
                    Open <ArrowRight aria-hidden className="size-3" />
                  </Link>
                )}
                {s.system && (
                  <button type="button" onClick={() => toggle(i)} aria-expanded={open === i} className="inline-flex items-center gap-1 font-medium text-fg hover:underline">
                    System <ChevronDown aria-hidden className={cn('size-3 transition-transform', open === i && 'rotate-180')} />
                  </button>
                )}
              </span>
            </div>
            {open === i && s.system && (
              <div className="mt-2 lg:hidden">
                <SystemPanel step={s} system={s.system} />
              </div>
            )}
            {i < flow.steps.length - 1 && (
              <span aria-hidden className="grid place-items-center py-1 text-subtle lg:px-1 lg:py-0">
                <ArrowRight className="size-4 rotate-90 lg:rotate-0" />
              </span>
            )}
          </li>
        ))}
      </ol>
      <div ref={panel} className={step?.system ? 'mt-4 hidden lg:block' : undefined}>
        {step?.system && <SystemPanel step={step} system={step.system} />}
      </div>
    </Card>
  )
}

/** Each state with the states it can move to, in the order the domain table lists them. */
export function StateMachineView({ machine }: { machine: StateMachine }) {
  const label = new Map(machine.states.map((s) => [s.id, s.label]))
  return (
    <ul className="stagger space-y-2">
      {machine.states.map((s) => {
        const next = machine.transitions.filter((t) => t.from === s.id)
        return (
          <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-panel bg-raised p-3 text-sm">
            <span className="inline-flex h-7 items-center rounded-full border border-line-strong bg-card px-3 font-medium">{s.label}</span>
            <ArrowRight aria-hidden className="size-4 text-subtle" />
            {next.length === 0 ? (
              <span className="text-muted">Final</span>
            ) : (
              next.map((t) => (
                <span key={t.to} className="inline-flex h-7 items-center rounded-full bg-card px-3 text-muted">
                  {label.get(t.to)}
                  {t.via && <span className="ml-1 text-xs">({t.via})</span>}
                </span>
              ))
            )}
          </li>
        )
      })}
    </ul>
  )
}
