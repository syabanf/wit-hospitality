import { useState } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, Check, Pause, Play, Search, Wrench } from 'lucide-react'
import type { TaskView } from '@/application/housekeeping'
import { TASK_CHECKLIST, TASK_STATUS_LABEL, TASK_TYPE_LABEL, type TaskAction } from '@/domain/housekeeping'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, type MaintenanceCategory } from '@/domain/maintenance'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Skeleton } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { TASK_TONE } from '../housekeeping/tones'
import { WindowTag } from '../shared/WindowTag'
import { Screen } from './Screen'

type Panel = 'done' | 'issue' | 'found' | 'override'
type Open = { id: string; panel: Panel } | null

/** The room attendant's list for today: start, pause and finish each room with its checklist, report faults and finds. */
export function RoomTasksScreen() {
  const { housekeeping } = useServices()
  const toast = useToast()
  const data = useResource('housekeeping.myTasks', () => housekeeping.myTasks())
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<Open>(null)

  async function run(t: TaskView, label: string, save: () => Promise<unknown>) {
    setBusy(t.id)
    try {
      await save()
      toast({ title: `${t.unitCode} ${label}` })
      setOpen(null)
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${t.unitCode}`, description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(null)
    }
  }
  const act = (t: TaskView, action: TaskAction, label: string) => void run(t, label, () => housekeeping.work(t.id, action))

  const d = data.data
  const card = (t: TaskView) => (
    <TaskCard
      key={t.id}
      t={t}
      busy={busy === t.id}
      canWork={Boolean(d?.canWork)}
      supervisor={Boolean(d?.supervisor)}
      open={open?.id === t.id ? open.panel : null}
      onOpen={(panel) => setOpen(open?.id === t.id && open.panel === panel ? null : { id: t.id, panel })}
      onAct={(action, label) => act(t, action, label)}
      onDone={(note) => void run(t, 'done', () => housekeeping.work(t.id, 'done', { checklist: TASK_CHECKLIST[t.type].map((item) => ({ item, ok: true })), note }))}
      onIssue={(input) => void run(t, 'fault reported', () => housekeeping.reportIssue(t.id, input))}
      onFound={(note) => void run(t, 'find noted', () => housekeeping.noteLostFound(t.id, note))}
      onOverride={(reason) => void run(t, 'started past do not disturb', () => housekeeping.work(t.id, 'start', { overrideReason: reason }))}
    />
  )

  return (
    <Screen title="My rooms" band="blush">
      {!d ? (
        <Skeleton className="h-40 rounded-[22px]" />
      ) : (
        <>
          <div className="flex items-center justify-between rounded-[22px] bg-card p-4 shadow-card">
            <div>
              <p className="text-xs text-muted">Credits today</p>
              <p className="text-2xl font-bold tabular">
                {d.credits} <span className="text-base font-medium text-muted">of {d.quota}</span>
              </p>
            </div>
            <p className="text-right text-xs text-muted">
              {d.mine.filter((t) => t.status === 'done').length} of {d.mine.length} rooms done
            </p>
          </div>
          {d.dnd.map((a) => (
            <p key={a.bookingId} className="flex items-start gap-2 rounded-[22px] bg-warning-soft p-3 text-sm">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" /> {a.unitCode}: do not disturb {a.days} days running. Tell the front desk.
            </p>
          ))}
          <section aria-labelledby="m-rooms-mine" className="space-y-2">
            <h2 id="m-rooms-mine" className="text-base font-semibold">
              My list <span className="text-muted tabular">{d.mine.length}</span>
            </h2>
            {d.mine.length === 0 ? <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">No rooms on your list today.</p> : <ul className="stagger space-y-2">{d.mine.map(card)}</ul>}
          </section>
          {d.others.length > 0 && (
            <section aria-labelledby="m-rooms-others" className="space-y-2">
              <h2 id="m-rooms-others" className="text-base font-semibold">
                Open on other lists <span className="text-muted tabular">{d.others.length}</span>
              </h2>
              <ul className="stagger space-y-2">{d.others.map(card)}</ul>
            </section>
          )}
        </>
      )}
    </Screen>
  )
}

interface CardProps {
  t: TaskView
  busy: boolean
  canWork: boolean
  supervisor: boolean
  open: Panel | null
  onOpen: (panel: Panel) => void
  onAct: (action: TaskAction, label: string) => void
  onDone: (note: string) => void
  onIssue: (input: { category: MaintenanceCategory; title: string; description: string; urgent: boolean }) => void
  onFound: (note: string) => void
  onOverride: (reason: string) => void
}

function TaskCard({ t, busy, canWork, supervisor, open, onOpen, onAct, onDone, onIssue, onFound, onOverride }: CardProps) {
  const [ticked, setTicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const [issue, setIssue] = useState({ category: 'other' as MaintenanceCategory, urgent: false })
  const working = t.status === 'in_progress' || t.status === 'paused'
  const guestService = t.type === 'stayover' || t.type === 'turndown'
  const shut = t.status === 'pending' && t.serviceWindow?.mode === 'dnd'
  const items = TASK_CHECKLIST[t.type]

  return (
    <li className="rounded-[22px] bg-card p-3 shadow-card">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span className="font-mono">{t.unitCode}</span> {TASK_TYPE_LABEL[t.type]}
          </p>
          <p className="truncate text-xs text-muted">
            {[t.guestName, t.attendantName && `for ${t.attendantName}`, `${t.credits} cr`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <StatusPill tone={TASK_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</StatusPill>
      </div>
      {t.serviceWindow && <WindowTag window={t.serviceWindow} className="mt-1.5" />}
      {(working || t.status === 'done') && (
        <p className="mt-1 text-xs text-muted">
          {t.minutes} of {t.standardMinutes} min
        </p>
      )}
      {t.workOrders.map((w) => (
        <Link key={w.id} to={`/maintenance/work-orders/${w.id}`} className="mt-1 flex items-center gap-1 text-xs text-accent-text">
          <Wrench aria-hidden className="size-3" /> {w.number}
        </Link>
      ))}
      {t.lostFound.map((f, i) => (
        <p key={i} className="mt-1 text-xs text-body">
          Found: {f.note}
          {f.ref && (
            <Link to={`/lost-found?status=all&q=${f.ref}`} className="ml-1 text-accent-text">
              in lost and found
            </Link>
          )}
        </p>
      ))}
      {canWork && (t.status === 'pending' || working) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {t.status === 'pending' && !shut && (
            <Button size="sm" variant="solid" loading={busy} onClick={() => onAct('start', 'started')}>
              <Play aria-hidden className="size-3.5" /> Start
            </Button>
          )}
          {shut && supervisor && (
            <Button size="sm" variant="soft" aria-pressed={open === 'override'} onClick={() => onOpen('override')}>
              <Play aria-hidden className="size-3.5" /> Go in anyway
            </Button>
          )}
          {t.status === 'pending' && guestService && (
            <>
              <Button size="sm" variant="soft" onClick={() => onAct('dnd', 'do not disturb')}>
                DND
              </Button>
              <Button size="sm" variant="soft" onClick={() => onAct('refused', 'service refused')}>
                Refused
              </Button>
            </>
          )}
          {t.status === 'in_progress' && (
            <Button size="sm" variant="soft" loading={busy} onClick={() => onAct('pause', 'paused')}>
              <Pause aria-hidden className="size-3.5" /> Pause
            </Button>
          )}
          {t.status === 'paused' && (
            <Button size="sm" variant="soft" loading={busy} onClick={() => onAct('resume', 'resumed')}>
              <Play aria-hidden className="size-3.5" /> Resume
            </Button>
          )}
          {working && (
            <Button size="sm" variant="accent" aria-pressed={open === 'done'} onClick={() => onOpen('done')}>
              <Check aria-hidden className="size-3.5" /> Done
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-pressed={open === 'issue'} onClick={() => onOpen('issue')}>
            <Wrench aria-hidden className="size-3.5" /> Fault
          </Button>
          <Button size="sm" variant="ghost" aria-pressed={open === 'found'} onClick={() => onOpen('found')}>
            <Search aria-hidden className="size-3.5" /> Found
          </Button>
        </div>
      )}
      {open === 'done' && (
        <div className="mt-3 animate-pop-in space-y-2 rounded-[18px] bg-raised p-3">
          {items.map((item) => (
            <label key={item} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-accent" checked={ticked.includes(item)} onChange={(e) => setTicked(e.target.checked ? [...ticked, item] : ticked.filter((x) => x !== item))} />
              {item}
            </label>
          ))}
          <Input className="h-10" placeholder="Note, optional" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" variant="accent" className="w-full" loading={busy} disabled={ticked.length < items.length} onClick={() => onDone(text)}>
            Finish the room
          </Button>
        </div>
      )}
      {open === 'issue' && (
        <div className="mt-3 animate-pop-in space-y-2 rounded-[18px] bg-raised p-3">
          <Select className="w-full" aria-label="Trade" value={issue.category} options={MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))} onChange={(e) => setIssue({ ...issue, category: e.target.value as MaintenanceCategory })} />
          <Input className="h-10" placeholder="Shower drain blocked" aria-label="What is wrong" value={text} onChange={(e) => setText(e.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={issue.urgent} label="Urgent" onChange={(urgent) => setIssue({ ...issue, urgent })} /> Urgent
          </label>
          <Button size="sm" variant="solid" className="w-full" loading={busy} onClick={() => onIssue({ ...issue, title: text, description: '' })}>
            Open a work order
          </Button>
        </div>
      )}
      {shut && !supervisor && <p className="mt-2 text-xs text-muted">The guest asked not to be disturbed. Ask a supervisor if the room needs you.</p>}
      {open === 'override' && (
        <div className="mt-3 animate-pop-in space-y-2 rounded-[18px] bg-raised p-3">
          <Input className="h-10" placeholder="Water leaking into the room below" aria-label="Why go in" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" variant="solid" className="w-full" loading={busy} disabled={text.trim().length < 3} onClick={() => onOverride(text)}>
            Start past do not disturb
          </Button>
        </div>
      )}
      {open === 'found' && (
        <div className="mt-3 animate-pop-in space-y-2 rounded-[18px] bg-raised p-3">
          <Input className="h-10" placeholder="Silver bracelet in the bedside drawer" aria-label="What was found" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" variant="solid" className="w-full" loading={busy} onClick={() => onFound(text)}>
            Note it on the room
          </Button>
        </div>
      )}
    </li>
  )
}
