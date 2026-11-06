import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Printer } from 'lucide-react'
import { periodLabel } from '@/domain/payroll'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { StatementSheet } from './StatementSheet'

/** One contract's month: the figures so far, then close, approve and pay from the same page. */
export default function OwnerStatementPage() {
  const { contractId = '', month = '' } = useParams()
  const { owners } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource(`owners.statement:${contractId}:${month}`, () => owners.statement(contractId, month), { keepPrevious: false })
  const [note, setNote] = useState('')
  const [bank, setBank] = useState('')
  const [busy, setBusy] = useState(false)

  async function act(title: string, run: () => Promise<unknown>) {
    setBusy(true)
    try {
      await run()
      toast({ title })
      setNote('')
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Not done', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={10} />
  const v = data.data
  const st = v.statement
  const accounts = v.banks
  const payFrom = bank || accounts[0]?.id || ''
  const ended = month < v.today.slice(0, 7)

  const actions = (
    <>
      {!st && can('finance', 'post') && ended && (
        <>
          <Input className="h-10 w-56" aria-label="Closing note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="accent" loading={busy} onClick={() => void act(`Closed the ${periodLabel(month)} statement`, () => owners.close(contractId, month, note))}>
            Close statement
          </Button>
        </>
      )}
      {st?.status === 'closed' && can('finance', 'approve') && (
        <Button variant="accent" loading={busy} onClick={() => void act(`Approved ${st.number}`, () => owners.approve(st.id, ''))}>
          Approve
        </Button>
      )}
      {st?.status === 'approved' && (st.payoutState === 'none' || st.payoutState === 'rejected') && st.figures.netPayable > 0 && can('finance', 'post') && (
        <>
          <Select aria-label="Pay from" value={payFrom} options={accounts.map((a) => ({ value: a.id, label: a.name }))} onChange={(e) => setBank(e.target.value)} />
          <Button variant="accent" loading={busy} onClick={() => void act(`Submitted the payout for ${st.number}`, () => owners.pay(st.id, payFrom))}>
            Pay the owner
          </Button>
        </>
      )}
      {st?.payout && (
        <Link to={`/finance/transactions/${st.payout.id}`} className="self-center text-sm font-medium hover:underline">
          Payout {st.payout.number}, {st.payoutLabel.toLowerCase()}
        </Link>
      )}
      {st?.journalId && (
        <Link to={`/accounting/journals/${st.journalId}`} className="self-center text-sm font-medium hover:underline">
          Close journal
        </Link>
      )}
      <Button variant="soft" onClick={() => window.print()}>
        <Printer aria-hidden className="size-4" /> Print or save as PDF
      </Button>
    </>
  )

  return (
    <div className="space-y-4">
      {!st && v.pending > 0 && <p className="text-sm text-warning print:hidden">{v.pending} entries of the villa in this month still wait for approval or posting; the statement closes once they are done.</p>}
      <StatementSheet view={v} operator actions={actions} />
    </div>
  )
}
