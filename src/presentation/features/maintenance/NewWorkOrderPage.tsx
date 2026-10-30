import { useNavigate, useSearchParams } from 'react-router'
import type { WorkOrderView } from '@/application/views'
import type { MaintenanceCategory } from '@/domain/maintenance'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { WorkOrderForm } from './WorkOrderForm'

/** Report a job; `?unit=`, `?asset=` and `?category=` prefill it from the page that links here. */
export default function NewWorkOrderPage() {
  const { maintenance } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const options = useResource('maintenance.formOptions', () => maintenance.formOptions())
  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (!options.data) return <CardSkeleton lines={8} />
  const o = options.data
  const unit = o.catalog.units.find((u) => u.id === params.get('unit'))
  const asset = o.assets.find((a) => a.id === params.get('asset'))
  return (
    <>
      <PageBar fallback="/maintenance/work-orders" label="Work orders" />
      <WorkOrderForm
        options={o}
        preset={{ villaId: asset?.villaId ?? unit?.villaId, unitId: asset?.unitId ?? unit?.id ?? null, assetId: asset?.id ?? null, category: (asset?.category ?? (params.get('category') as MaintenanceCategory | null)) ?? undefined }}
        save={(input) => maintenance.createWorkOrder(input)}
        onDone={(result) => {
          const w = result as WorkOrderView
          toast({ title: `Opened ${w.number}`, description: w.title })
          navigate(`/maintenance/work-orders/${w.id}`)
        }}
        onCancel={() => navigate(-1)}
      />
    </>
  )
}
