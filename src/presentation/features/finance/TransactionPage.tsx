import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeftRight, CircleCheck, Paperclip, RotateCcw, Send, ShieldCheck, Undo2, XCircle } from 'lucide-react'
import type { TransactionAction } from '@/application/ports'
import { ROLE_LABEL } from '@/domain/access'
import { KIND_LABEL, ORIGIN_LABEL, TRANSACTION_EVENT_LABEL, TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { Popover } from '../../ui/Popover'
import { Steps } from '../../ui/Steps'
import { useToast } from '../../ui/useToast'
import { TRANSACTION_TONE } from '../shared/tones'
import { ORIGIN_TONE } from './financeTones'

type Busy = 'submit' | 'approve' | 'reject' | 'post' | 'reverse'

export default function TransactionPage() {
  const { id = '' } = useParams()
  const { finance } = useServices()
  const toast = useToast()
  const resource = useResource(`finance.transaction:${id}`, () => finance.transaction(id), { keepPrevious: false })
  const [busy, setBusy] = useState<Busy | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(key: Busy, label: string, action: () => Promise<unknown>, description?: string) {
    setBusy(key)
    setErrors({})
    try {
      await action()
      toast({ title: label, description })
      resource.reload()
      return true
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: `Could not ${label.toLowerCase()}`, description: Object.values(e)[0] })
      return false
    } finally {
      setBusy(null)
    }
  }

  /** A popover body: one note field and the action. */
  const noteForm = (key: Busy, field: string, label: string, placeholder: string, action: (note: string) => Promise<unknown>, blurb: string, done: string, variant: 'accent' | 'solid' = 'accent') => (close: () => void) => (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        const note = String(new FormData(e.currentTarget).get(field) ?? '')
        void run(key, done, () => action(note)).then((ok) => ok && close())
      }}
      className="space-y-3"
    >
      <p className="text-sm">{blurb}</p>
      <Field label={label} htmlFor={`${key}-${field}`} error={errors[field] ?? errors.note ?? errors.form}>
        <Input id={`${key}-${field}`} name={field} placeholder={placeholder} />
      </Field>
      <Button type="submit" variant={variant} size="sm" loading={busy === key}>
        {done.split(' ')[0]}
      </Button>
    </form>
  )

  return (
    <Gate resource={resource} what="transaction" back={{ to: '/finance/transactions', label: 'Back to transactions' }}>
      {({ transaction: t, steps, progress, rule, canSign, canPost, canReject, reversal, original, twin, booking }) => {
        const transition = (to: TransactionAction, note = '') => finance.transition(t.id, to, note)
        return (
          <>
            <PageBar
              fallback="/finance/transactions"
              label="Transactions"
              actions={
                <>
                  {t.status === 'posted' && (
                    <Popover
                      align="right"
                      className="w-80 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <Undo2 aria-hidden className="size-4" /> Reverse
                        </Button>
                      )}
                    >
                      {noteForm('reverse', 'reason', 'Reason', 'Why the entry was wrong', (reason) => finance.reverse(t.id, reason), 'Posted money is never edited. A reversal posts the opposite entry and links the two.', `Reversed ${t.number}`)}
                    </Popover>
                  )}
                  {(t.status === 'draft' || t.status === 'rejected') && (
                    <Button variant="accent" loading={busy === 'submit'} onClick={() => void run('submit', t.status === 'rejected' ? `Resubmitted ${t.number}` : `Submitted ${t.number}`, () => transition('submitted'))}>
                      {t.status === 'rejected' ? <RotateCcw aria-hidden className="size-4" /> : <Send aria-hidden className="size-4" />}
                      {t.status === 'rejected' ? 'Resubmit' : 'Submit for approval'}
                    </Button>
                  )}
                  {canReject && (
                    <Popover
                      align="right"
                      className="w-80 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <XCircle aria-hidden className="size-4" /> Reject
                        </Button>
                      )}
                    >
                      {noteForm('reject', 'note', 'Reason', 'What has to change before it comes back', (note) => transition('rejected', note), 'The author sees the reason and can fix the entry and resubmit it.', `Rejected ${t.number}`, 'solid')}
                    </Popover>
                  )}
                  {canSign && (
                    <Popover
                      align="right"
                      className="w-80 p-4"
                      trigger={(props) => (
                        <Button {...props} variant="accent">
                          <ShieldCheck aria-hidden className="size-4" /> Sign level {progress.done + 1} of {progress.levels.length}
                        </Button>
                      )}
                    >
                      {noteForm('approve', 'note', 'Note (optional)', 'For the record', (note) => transition('approved', note), progress.levels.length === progress.done + 1 ? 'Your signature completes the chain; finance can then post it.' : `After you, ${ROLE_LABEL[progress.levels[progress.done + 1] ?? 'finance']} signs.`, `Signed ${t.number}`)}
                    </Popover>
                  )}
                  {canPost && (
                    <Button variant="accent" loading={busy === 'post'} onClick={() => void run('post', `Posted ${t.number}`, () => transition('posted'), 'The balance has moved')}>
                      <CircleCheck aria-hidden className="size-4" /> Post
                    </Button>
                  )}
                </>
              }
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                {t.status === 'rejected' && (
                  <p role="status" className="rounded-panel bg-danger-soft p-3.5 text-sm text-danger">
                    <span className="font-semibold">Rejected.</span> {t.rejectionReason}
                  </p>
                )}
                <Card aria-label={`Transaction ${t.number}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">
                        {t.number}
                        {t.reference && ` · Ref ${t.reference}`}
                      </p>
                      <Headline className="mt-1">{t.description}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        {KIND_LABEL[t.kind]} on {shortDay(t.date)} · {t.categoryName}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Tag tone={ORIGIN_TONE[t.origin]}>{ORIGIN_LABEL[t.origin]}</Tag>
                      <StatusPill tone={TRANSACTION_TONE[t.status]}>{TRANSACTION_STATUS_LABEL[t.status]}</StatusPill>
                    </div>
                  </div>
                  <p className={cn('mt-6 min-w-0 text-[44px] leading-none font-medium tracking-tight break-words tabular', t.kind === 'cash_out' && 'text-muted')}>
                    {t.kind === 'cash_out' ? '-' : '+'}
                    {money(t.amount)}
                  </p>
                  <FactGrid
                    className="mt-6 grid-cols-2 sm:grid-cols-3"
                    facts={[
                      ['Account', <Link key="a" to={`/finance/accounts/${t.accountId}`} className="hover:underline">{t.accountName}</Link>],
                      ['Location', t.location.name],
                      ['Villa', t.villa ? <Link key="v" to={`/property/villas/${t.villa.id}`} className="hover:underline">{t.villa.name}</Link> : 'Not mapped'],
                      ['Unit', t.unit ? <Link key="u" to={`/property/units/${t.unit.id}`} className="font-mono hover:underline">{t.unit.code}</Link> : 'Not mapped'],
                      ['Reference', t.reference ? <span key="r" className="font-mono">{t.reference}</span> : 'None'],
                      ['Recorded by', `${t.createdBy}, ${shortDay(t.createdOn)}`],
                    ]}
                  />
                  {(original || reversal || twin) && (
                    <p className="mt-4 rounded-panel bg-info-soft p-3.5 text-sm text-body">
                      {original && (
                        <>
                          This entry reverses{' '}
                          <Link to={`/finance/transactions/${original.id}`} className="font-mono font-medium hover:underline">
                            {original.number}
                          </Link>
                          .{' '}
                        </>
                      )}
                      {reversal && (
                        <>
                          Reversed by{' '}
                          <Link to={`/finance/transactions/${reversal.id}`} className="font-mono font-medium hover:underline">
                            {reversal.number}
                          </Link>{' '}
                          on {shortDay(reversal.date)}.{' '}
                        </>
                      )}
                      {twin && (
                        <>
                          <ArrowLeftRight aria-hidden className="mr-1 inline size-3.5" />
                          Other half of the transfer:{' '}
                          <Link to={`/finance/transactions/${twin.id}`} className="font-mono font-medium hover:underline">
                            {twin.number}
                          </Link>{' '}
                          on {twin.accountName}.
                        </>
                      )}
                    </p>
                  )}
                </Card>
                <Card aria-labelledby="att-title">
                  <CardHeader id="att-title" title="Attachments" />
                  {t.attachments.length === 0 ? (
                    <p className="text-sm text-muted">No receipt or evidence attached.</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {t.attachments.map((name) => (
                        <li key={name} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-3 text-xs font-medium">
                          <Paperclip aria-hidden className="size-3.5 text-muted" />
                          {name}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card aria-labelledby="hist-title">
                  <CardHeader id="hist-title" title="History" />
                  <ol className="divide-y divide-line">
                    {t.history.map((e, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5 text-sm first:pt-0 last:pb-0">
                        <span className="w-24 shrink-0 font-medium">{TRANSACTION_EVENT_LABEL[e.kind]}</span>
                        <span className="min-w-0 flex-1">
                          {e.by} <span className="text-muted">· {ROLE_LABEL[e.role]}</span>
                          {e.note && <span className="block text-xs text-muted">{e.note}</span>}
                        </span>
                        <span className="text-xs text-muted">{shortDay(e.on)}</span>
                      </li>
                    ))}
                  </ol>
                </Card>
                {booking && (
                  <Card aria-labelledby="linked-title">
                    <CardHeader id="linked-title" title="Linked booking" />
                    <Link to={`/bookings/${booking.id}`} className="flex items-center justify-between rounded-panel bg-raised px-4 py-3 text-sm transition-colors hover:bg-control">
                      <span>
                        <span className="font-mono">{booking.code}</span> · {booking.guestName} · {booking.unitCode}
                      </span>
                      <span aria-hidden>→</span>
                    </Link>
                  </Card>
                )}
              </div>
              <div className="space-y-4">
                <Card aria-labelledby="chain-title">
                  <CardHeader id="chain-title" title="Approval chain" />
                  <p className="mb-3 text-xs text-muted">{rule ? `Rule: ${rule.name}` : 'Default: one villa manager signs.'}</p>
                  <ol className="space-y-2">
                    {progress.levels.map((role, i) => {
                      const grant = t.approvals[i]
                      const next = !grant && i === progress.done && t.status === 'submitted'
                      return (
                        <li key={`${role}-${i}`} className={cn('flex items-center gap-3 rounded-panel p-3 text-sm', grant ? 'bg-success-soft' : next ? 'bg-accent-soft' : 'bg-raised')}>
                          <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold', grant ? 'bg-success text-white' : next ? 'bg-accent-strong text-white' : 'bg-control text-muted')}>{i + 1}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">{ROLE_LABEL[role]}</span>
                            <span className="block truncate text-xs text-muted">{grant ? `${grant.by}, ${shortDay(grant.on)}${grant.note ? ` · ${grant.note}` : ''}` : next ? 'Waiting for a signature' : t.status === 'submitted' ? 'Later' : 'Not reached'}</span>
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                </Card>
                <Card aria-labelledby="tsteps-title">
                  <CardHeader id="tsteps-title" title="Lifecycle" />
                  <Steps label="Transaction lifecycle" steps={steps} />
                </Card>
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}
