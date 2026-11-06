import { Link, useParams } from 'react-router'
import { ORIGIN_LABEL } from '@/domain/finance'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Gate } from '../../ui/Gate'
import { FactGrid } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { Amount } from './shared'

/** One journal entry: its lines, who posted it and the record that wrote it. */
export default function JournalPage() {
  const { id = '' } = useParams()
  const { accounting } = useServices()
  const data = useResource(`accounting.journal:${id}`, () => accounting.journal(id), { keepPrevious: false })

  return (
    <>
      <PageBar
        fallback="/accounting/journals"
        label="Journals"
        actions={
          data.data?.href && (
            <Link to={data.data.href} className={buttonStyles({ variant: 'card' })}>
              Open {data.data.sourceLabel.toLowerCase()} {data.data.sourceNumber}
            </Link>
          )
        }
      />
      <Gate resource={data} back={{ to: '/accounting/journals', label: 'All journals' }} what="journal entry">
        {(e) => (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <Card aria-labelledby="je-lines">
              <CardHeader id="je-lines" title={`${e.number}: ${e.memo}`} />
              <DataTable
                label="Journal lines"
                rows={e.lines.map((l, i) => ({ ...l, key: `${i}` }))}
                rowKey={(l) => l.key}
                columns={[
                  { key: 'account', header: 'Account', cell: (l) => <Link to={`/accounting/ledger?account=${l.accountId}`} className="hover:underline">{l.account.code} {l.account.name}</Link> },
                  { key: 'debit', header: 'Debit', align: 'right', cell: (l) => <Amount value={l.debit} /> },
                  { key: 'credit', header: 'Credit', align: 'right', cell: (l) => <Amount value={l.credit} /> },
                ]}
                footer={['Total', money(e.amount), money(e.amount)]}
              />
            </Card>
            <Card aria-labelledby="je-facts">
              <CardHeader id="je-facts" title="Entry" />
              <FactGrid
                facts={[
                  ['Date', e.date],
                  ['Source', `${e.sourceLabel} ${e.sourceNumber}`],
                  ['Origin', e.origin ? ORIGIN_LABEL[e.origin] : '–'],
                  ['Villa', e.villaName],
                  ['Posted', `${e.postedOn} by ${e.postedBy}`],
                ]}
              />
            </Card>
          </div>
        )}
      </Gate>
    </>
  )
}
