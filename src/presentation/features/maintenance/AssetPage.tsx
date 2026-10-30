import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Pencil, Wrench } from 'lucide-react'
import { ASSET_STATUS_LABEL, intervalLabel, MAINTENANCE_CATEGORY_LABEL } from '@/domain/maintenance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { AssetForm } from './AssetForm'
import { ASSET_TONE } from './tones'
import { WorkOrderTable } from './WorkOrderTable'

export default function AssetPage() {
  const { id = '' } = useParams()
  const { maintenance } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const resource = useResource(`maintenance.asset:${id}`, () => maintenance.asset(id), { keepPrevious: false })
  const [editing, setEditing] = useState(false)

  return (
    <Gate resource={resource} what="asset" back={{ to: '/maintenance/assets', label: 'Back to assets' }}>
      {({ asset: a, workOrders, plans, catalog, today }) => (
        <>
          <PageBar
            fallback="/maintenance/assets"
            label="Assets"
            actions={
              <>
                {can('maintenance', 'edit') && (
                  <Button variant="card" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                    <Pencil aria-hidden className="size-4" /> Edit
                  </Button>
                )}
                {can('maintenance', 'create') && (
                  <Link to={`/maintenance/work-orders/new?asset=${a.id}`} className={buttonStyles({ variant: 'accent' })}>
                    <Wrench aria-hidden className="size-4" /> Report a fault
                  </Link>
                )}
              </>
            }
          />
          <div className="space-y-4">
            {editing && (
              <AssetForm
                initial={a}
                catalog={catalog}
                save={(input) => maintenance.updateAsset(a.id, input)}
                onDone={() => {
                  toast({ title: `Saved ${a.code}` })
                  setEditing(false)
                  resource.reload()
                }}
                onCancel={() => setEditing(false)}
              />
            )}
            <Card aria-label={a.name}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-muted">{a.code}</p>
                  <Headline className="mt-1">{a.name}</Headline>
                  <p className="mt-1 text-sm text-muted">
                    {a.unitId ? <Link to={`/property/units/${a.unitId}`} className="font-mono hover:underline">{a.unitCode}</Link> : 'Shared'} · {a.villaName}
                  </p>
                </div>
                <StatusPill tone={ASSET_TONE[a.status]}>{ASSET_STATUS_LABEL[a.status]}</StatusPill>
              </div>
              <FactGrid
                className="mt-5 grid-cols-2 sm:grid-cols-3"
                facts={[
                  ['Category', MAINTENANCE_CATEGORY_LABEL[a.category]],
                  ['Brand and model', `${a.brand} ${a.model}`.trim() || 'Not noted'],
                  ['Serial', <span key="s" className="font-mono text-sm">{a.serial || 'Not noted'}</span>],
                  ['Bought', a.purchasedOn ? shortDay(a.purchasedOn) : 'Unknown'],
                  ['Purchase cost', money(a.purchaseCost)],
                  ['Warranty', a.warrantyUntil ? `${a.inWarranty ? 'Until' : 'Ended'} ${shortDay(a.warrantyUntil)}` : 'None'],
                ]}
              />
              {a.notes && <p className="mt-4 text-sm text-body">{a.notes}</p>}
            </Card>
            <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile label="Jobs" value={a.workOrders} hint={`${a.openJobs} open`} />
              <StatTile label="Repair cost to date" value={money(a.costToDate)} hint={a.purchaseCost ? `${Math.round((a.costToDate / a.purchaseCost) * 100)}% of the purchase` : undefined} />
              <StatTile label="Warranty" value={a.inWarranty ? 'Active' : 'None'} hint={a.inWarranty && a.warrantyUntil ? `Claim before ${shortDay(a.warrantyUntil)}` : `Checked ${shortDay(today)}`} />
            </div>
            <Card className="p-0" aria-labelledby="as-jobs">
              <div className="p-5 pb-0">
                <CardHeader id="as-jobs" title="Job history" />
              </div>
              <WorkOrderTable label={`Jobs on ${a.code}`} rows={workOrders} exportName={`asset-${a.code}`} exportDate={today} />
            </Card>
            {plans.length > 0 && (
              <Card aria-labelledby="as-plans">
                <CardHeader id="as-plans" title="Preventive plans" />
                <ul className="divide-y divide-line">
                  {plans.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                      <span className="min-w-0 flex-1 font-medium">{p.title}</span>
                      <span className="text-muted">{intervalLabel(p)}</span>
                      <span className="text-muted">next {shortDay(p.nextDue)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </>
      )}
    </Gate>
  )
}
