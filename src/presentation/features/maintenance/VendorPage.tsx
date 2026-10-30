import { useState } from 'react'
import { useParams } from 'react-router'
import { Pencil } from 'lucide-react'
import { intervalLabel, isOpenWorkOrder, MAINTENANCE_CATEGORY_LABEL } from '@/domain/maintenance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { VendorForm } from './VendorForm'
import { WorkOrderTable } from './WorkOrderTable'

export default function VendorPage() {
  const { id = '' } = useParams()
  const { maintenance } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const resource = useResource(`maintenance.vendor:${id}`, () => maintenance.vendor(id), { keepPrevious: false })
  const [editing, setEditing] = useState(false)

  return (
    <Gate resource={resource} what="vendor" back={{ to: '/maintenance/vendors', label: 'Back to vendors' }}>
      {({ vendor: v, workOrders, plans, today }) => (
        <>
          <PageBar
            fallback="/maintenance/vendors"
            label="Vendors"
            actions={
              can('maintenance', 'edit') && (
                <Button variant="card" aria-pressed={editing} onClick={() => setEditing((x) => !x)}>
                  <Pencil aria-hidden className="size-4" /> Edit
                </Button>
              )
            }
          />
          <div className="space-y-4">
            {editing && (
              <VendorForm
                initial={v}
                save={(input) => maintenance.updateVendor(v.id, input)}
                onDone={() => {
                  toast({ title: `Saved ${v.name}` })
                  setEditing(false)
                  resource.reload()
                }}
                onCancel={() => setEditing(false)}
              />
            )}
            <Card aria-label={v.name}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <Headline>{v.name}</Headline>
                  <p className="mt-1 text-sm text-muted">{MAINTENANCE_CATEGORY_LABEL[v.trade]}</p>
                </div>
                <Tag tone={v.active ? 'success' : 'neutral'}>{v.active ? 'Active' : 'Inactive'}</Tag>
              </div>
              <FactGrid
                className="mt-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4"
                facts={[
                  ['Contact', v.contact || 'Not noted'],
                  ['Phone', v.phone ? <a key="p" href={`tel:${v.phone.replace(/\s/g, '')}`} className="text-accent-text hover:underline">{v.phone}</a> : 'Not noted'],
                  ['Email', v.email ? <a key="e" href={`mailto:${v.email}`} className="break-all text-accent-text hover:underline">{v.email}</a> : 'Not noted'],
                  ['Rate', v.rateNote || 'Not agreed'],
                ]}
              />
            </Card>
            <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile label="Jobs" value={v.workOrders} hint={`${workOrders.filter(isOpenWorkOrder).length} open`} />
              <StatTile label="Spend" value={money(v.spend)} hint="Jobs not cancelled" />
              <StatTile label="Plans" value={plans.length} hint="Recurring work" />
            </div>
            <Card className="p-0" aria-labelledby="vn-jobs">
              <div className="p-5 pb-0">
                <CardHeader id="vn-jobs" title="Jobs" />
              </div>
              <WorkOrderTable label={`Jobs for ${v.name}`} rows={workOrders} exportName={`vendor-${v.id}`} exportDate={today} />
            </Card>
            {plans.length > 0 && (
              <Card aria-labelledby="vn-plans">
                <CardHeader id="vn-plans" title="Preventive plans" />
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
