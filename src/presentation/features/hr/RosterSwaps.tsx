import { useState } from 'react'
import { swapOpen } from '@/domain/selfService'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { Tabs } from '../../ui/Tabs'
import { SwapList } from '../shared/SwapList'

const VIEWS = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
] as const

/** Shift swaps in the user's villas; an accepted one carries Approve and Reject for whoever edits the roster. */
export function RosterSwaps({ onDecided }: { onDecided: () => void }) {
  const { selfService } = useServices()
  const { can } = useAccess()
  const data = useResource('selfService.swaps', () => selfService.swaps())
  const [view, setView] = useState<'open' | 'all'>('open')
  const swaps = data.data ?? []
  const open = swaps.filter(swapOpen)
  const shown = view === 'open' ? open : swaps
  return (
    <Card aria-labelledby="roster-swaps">
      <CardHeader id="roster-swaps" title={`Shift swaps${open.length ? ` (${open.length} open)` : ''}`} action={<Tabs label="Which swaps" options={VIEWS} value={view} onChange={setView} />} />
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{data.data ? 'No swaps to decide. Staff offer swaps from Team shifts; an accepted one shows here.' : 'Loading swaps…'}</p>
      ) : (
        <SwapList
          swaps={shown}
          canDecide={can('hr', 'edit')}
          onDone={() => {
            data.reload()
            onDecided()
          }}
        />
      )}
    </Card>
  )
}
