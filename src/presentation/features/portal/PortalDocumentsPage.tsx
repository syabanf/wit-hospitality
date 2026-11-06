import { FileText } from 'lucide-react'
import { CHARGED_LABEL, FEE_BASIS_LABEL, OWNER_STAY_PRICING_LABEL } from '@/domain/owner'
import { fullDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, ErrorState } from '../../ui/States'

/** The management contracts and the payout details the operator holds. */
export default function PortalDocumentsPage() {
  const { portal } = useServices()
  const data = useResource('portal.documents', () => portal.documents())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const { owner, contracts } = data.data
  return (
    <div className="space-y-4">
      {contracts.map((c) => (
        <Card key={c.id} aria-labelledby={`doc-${c.id}`}>
          <CardHeader id={`doc-${c.id}`} title={`${c.villa.name}, contract ${c.number}`} icon={<FileText aria-hidden className="size-4" />} />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {[
              ['Runs', `${fullDay(c.start)} to ${fullDay(c.end)}`],
              ['Management fee', `${c.feePct}% of ${FEE_BASIS_LABEL[c.feeBasis].toLowerCase()}${c.fixedMonthlyFee ? ` plus ${money(c.fixedMonthlyFee)} a month` : ''}`],
              ['Costs charged to you', `${CHARGED_LABEL[c.charged]}${c.charged === 'maintenance' ? ` from ${money(c.maintenanceThreshold)}` : ''}`],
              ['FF&E reserve', `${c.reservePct}% of revenue`],
              ['Owner nights', `${c.ownerNightsPerYear} a year, ${OWNER_STAY_PRICING_LABEL[c.ownerStayPricing].toLowerCase()}${c.ownerStayPrice ? ` ${money(c.ownerStayPrice)}` : ''}`],
              ['Payout', `Monthly, by the ${c.payoutDay}th of the next month`],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {c.document && (
            <p className="mt-4 text-sm">
              {c.document.url ? (
                <a href={c.document.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {c.document.name}
                </a>
              ) : (
                <span className="font-medium">{c.document.name}</span>
              )}
              <span className="text-muted"> · signed copy on file with the operator</span>
            </p>
          )}
        </Card>
      ))}
      <Card aria-labelledby="doc-owner">
        <CardHeader id="doc-owner" title="Your payout details" />
        <p className="text-sm">
          {owner.bank.bank} {owner.bank.accountNumber}, {owner.bank.accountName}
          {owner.npwp && ` · NPWP ${owner.npwp}`}
        </p>
        <p className="mt-1 text-xs text-muted">To change them, write to the operator; finance updates them before the next payout.</p>
      </Card>
    </div>
  )
}
