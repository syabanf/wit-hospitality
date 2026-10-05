import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { CircleCheck, Send, ShieldCheck, Undo2 } from 'lucide-react'
import type { TransactionAction } from '@/application/ports'
import { KIND_LABEL, nextTransactionStep, TRANSACTION_ACTION_LABEL, TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
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

const ICON = { submitted: Send, approved: ShieldCheck, posted: CircleCheck } as const

export default function TransactionPage() {
  const { id = '' } = useParams()
  const { finance } = useServices()
  const toast = useToast()
  const resource = useResource(`finance.transaction:${id}`, () => finance.transaction(id), { keepPrevious: false })
  const [busy, setBusy] = useState<'step' | 'reverse' | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(key: NonNullable<typeof busy>, label: string, action: () => Promise<unknown>, description?: string) {
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

  return (
    <Gate resource={resource} what="transaction" back={{ to: '/finance/transactions', label: 'Back to transactions' }}>
      {({ transaction: t, steps, reversal, original, booking }) => {
        const step = nextTransactionStep(t) as TransactionAction | null
        const StepIcon = step ? ICON[step] : null
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
                      {(close) => (
                        <form
                          onSubmit={(e: FormEvent<HTMLFormElement>) => {
                            e.preventDefault()
                            const reason = String(new FormData(e.currentTarget).get('reason') ?? '')
                            void run('reverse', `Reversed ${t.number}`, () => finance.reverse(t.id, reason), 'A compensating entry was posted').then((ok) => ok && close())
                          }}
                          className="space-y-3"
                        >
                          <p className="text-sm">Posted money is never edited. A reversal posts the opposite entry and links the two.</p>
                          <Field label="Reason" htmlFor="rev-reason" error={errors.reason}>
                            <Input id="rev-reason" name="reason" placeholder="Why the entry was wrong" />
                          </Field>
                          <Button type="submit" variant="accent" size="sm" loading={busy === 'reverse'}>
                            Post reversal
                          </Button>
                        </form>
                      )}
                    </Popover>
                  )}
                  {step && StepIcon && (
                    <Button variant="accent" loading={busy === 'step'} onClick={() => void run('step', `${TRANSACTION_STATUS_LABEL[step]} ${t.number}`, () => finance.transition(t.id, step))}>
                      <StepIcon aria-hidden className="size-4" /> {TRANSACTION_ACTION_LABEL[step]}
                    </Button>
                  )}
                </>
              }
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                <Card aria-label={`Transaction ${t.number}`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">{t.number}</p>
                      <Headline className="mt-1">{t.description}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        {KIND_LABEL[t.kind]} on {shortDay(t.date)} · {t.categoryName}
                      </p>
                    </div>
                    <StatusPill tone={TRANSACTION_TONE[t.status]}>{TRANSACTION_STATUS_LABEL[t.status]}</StatusPill>
                  </div>
                  <p className={cn('mt-6 text-[44px] leading-none font-medium tracking-tight tabular', t.kind === 'cash_out' && 'text-muted')}>
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
                      ['Recorded by', t.createdBy],
                      ['Recorded on', shortDay(t.createdOn)],
                    ]}
                  />
                  {(original || reversal) && (
                    <p className="mt-4 rounded-panel bg-info-soft p-3.5 text-sm text-body">
                      {original && (
                        <>
                          This entry reverses{' '}
                          <Link to={`/finance/transactions/${original.id}`} className="font-mono font-medium hover:underline">
                            {original.number}
                          </Link>
                          .
                        </>
                      )}
                      {reversal && (
                        <>
                          Reversed by{' '}
                          <Link to={`/finance/transactions/${reversal.id}`} className="font-mono font-medium hover:underline">
                            {reversal.number}
                          </Link>{' '}
                          on {shortDay(reversal.date)}.
                        </>
                      )}
                    </p>
                  )}
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
