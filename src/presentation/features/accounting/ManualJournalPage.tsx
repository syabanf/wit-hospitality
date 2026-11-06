import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { ROLE_LABEL } from '@/domain/access'
import { canSignLevel } from '@/domain/approval'
import { TRANSACTION_EVENT_LABEL, TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { money } from '@/lib/format'
import type { TransactionAction } from '@/application/ports'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Input } from '../../ui/Field'
import { Gate } from '../../ui/Gate'
import { FactGrid } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { useToast } from '../../ui/useToast'
import { AttachmentList } from '../shared/Attachments'
import { TRANSACTION_TONE } from '../shared/tones'
import { Amount } from './shared'

/** One manual journal: its lines, the approval chain and the actions the signed-in role may take. */
export default function ManualJournalPage() {
  const { id = '' } = useParams()
  const { accounting } = useServices()
  const { can, user } = useAccess()
  const toast = useToast()
  const data = useResource(`accounting.manual:${id}`, () => accounting.manualJournal(id), { keepPrevious: false })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function act(to: TransactionAction) {
    setBusy(true)
    try {
      const m = await accounting.transitionManualJournal(id, to, note)
      toast({ title: `${m.number} ${TRANSACTION_STATUS_LABEL[m.status].toLowerCase()}`, description: m.status === 'posted' ? 'The journal entry is in the books.' : undefined })
      setNote('')
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not change the journal', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageBar fallback="/accounting/manual" label="Manual journals" />
      <Gate resource={data} back={{ to: '/accounting/manual', label: 'All manual journals' }} what="manual journal">
        {(m) => {
          const next = m.progress.next
          const actions: Array<{ to: TransactionAction; label: string; show: boolean }> = [
            { to: 'submitted', label: m.status === 'rejected' ? 'Resubmit' : 'Submit for approval', show: (m.status === 'draft' || m.status === 'rejected') && can('finance', 'submit') },
            { to: 'approved', label: next ? `Sign as ${ROLE_LABEL[next]}` : 'Approve', show: m.status === 'submitted' && can('approval', 'approve') && next !== null && canSignLevel(user.role, next) && m.createdById !== user.id },
            { to: 'rejected', label: 'Reject', show: m.status === 'submitted' && can('approval', 'approve') && m.createdById !== user.id },
            { to: 'posted', label: 'Post', show: m.status === 'approved' && can('finance', 'post') },
          ]
          const open = actions.filter((a) => a.show)
          return (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-4">
                <Card aria-labelledby="mj-lines">
                  <CardHeader id="mj-lines" title={`${m.number}: ${m.memo}`} action={<StatusPill tone={TRANSACTION_TONE[m.status]}>{TRANSACTION_STATUS_LABEL[m.status]}</StatusPill>} />
                  <DataTable
                    label="Journal lines"
                    rows={m.lines.map((l, i) => ({ ...l, key: `${i}` }))}
                    rowKey={(l) => l.key}
                    columns={[
                      { key: 'account', header: 'Account', cell: (l) => `${l.account.code} ${l.account.name}` },
                      { key: 'debit', header: 'Debit', align: 'right', cell: (l) => <Amount value={l.debit} /> },
                      { key: 'credit', header: 'Credit', align: 'right', cell: (l) => <Amount value={l.credit} /> },
                    ]}
                    footer={['Total', money(m.amount), money(m.amount)]}
                  />
                  <div className="mt-4">
                    <AttachmentList files={m.attachments} empty="No evidence attached." />
                  </div>
                </Card>
                <Card aria-labelledby="mj-history">
                  <CardHeader id="mj-history" title="History" />
                  <ul className="space-y-2 text-sm">
                    {m.history.map((h, i) => (
                      <li key={i}>
                        <span className="font-medium">{TRANSACTION_EVENT_LABEL[h.kind]}</span> <span className="text-muted">{h.on} by {h.by}{h.note ? `: ${h.note}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
              <div className="space-y-4">
                <Card aria-labelledby="mj-facts">
                  <CardHeader id="mj-facts" title="Journal" />
                  <FactGrid
                    facts={[
                      ['Date', m.date],
                      ['Villa', m.villaName],
                      ['Written by', m.createdBy],
                      ['Chain', m.progress.levels.map((r) => ROLE_LABEL[r]).join(', then ')],
                      ['Signed', `${m.progress.done} of ${m.progress.levels.length}`],
                      ['Rejection', m.rejectionReason ?? '–'],
                    ]}
                  />
                  {m.journalId && (
                    <Link to={`/accounting/journals/${m.journalId}`} className={buttonStyles({ variant: 'card', className: 'mt-4 w-full' })}>
                      Open the journal entry
                    </Link>
                  )}
                </Card>
                {open.length > 0 && (
                  <Card aria-labelledby="mj-actions">
                    <CardHeader id="mj-actions" title="Next step" />
                    <Input aria-label="Note" placeholder={m.status === 'submitted' ? 'Note, required to reject' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
                    <div className="mt-3 flex flex-wrap gap-2">
                      {open.map((a) => (
                        <Button key={a.to} variant={a.to === 'rejected' ? 'card' : 'accent'} disabled={busy} onClick={() => void act(a.to)}>
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            </div>
          )
        }}
      </Gate>
    </>
  )
}
