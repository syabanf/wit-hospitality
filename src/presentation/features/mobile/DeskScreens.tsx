import { useNavigate, useParams } from 'react-router'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Fallback } from '../../ui/Gate'
import { useToast } from '../../ui/useToast'
import { CheckInForm } from '../shared/CheckInForm'
import { CheckOutForm } from '../shared/CheckOutForm'
import { Screen, ScreenSkeleton } from './Screen'

/** Arrival checklist on the phone; completes the check-in and books the deposit. */
export function CheckInScreen() {
  const { id = '' } = useParams()
  const { booking } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const resource = useResource(`booking.detail:${id}`, () => booking.detail(id), { keepPrevious: false })
  const d = resource.data
  return (
    <Screen title="Check in">
      {!d ? (
        <Fallback error={resource.error} onRetry={resource.reload} what="booking" back={{ to: '/m', label: 'Back to today' }} loading={<ScreenSkeleton />} />
      ) : d.booking.status !== 'confirmed' ? (
        <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">This stay is {d.booking.status.replace('_', ' ')}; nothing to check in.</p>
      ) : (
        <div className="rounded-[26px] bg-card p-4 shadow-card">
          <CheckInForm
            booking={d.booking}
            cashbox={d.cashbox}
            save={(details) => booking.checkIn(d.booking.id, details)}
            onDone={() => {
              toast({ title: `Checked in ${d.booking.guestName}`, description: d.booking.unitCode })
              navigate(`/m/bookings/${d.booking.id}`, { replace: true })
            }}
          />
        </div>
      )}
    </Screen>
  )
}

/** Departure checklist on the phone; completes the check-out and books deposit return and charges. */
export function CheckOutScreen() {
  const { id = '' } = useParams()
  const { booking } = useServices()
  const navigate = useNavigate()
  const toast = useToast()
  const resource = useResource(`booking.detail:${id}`, () => booking.detail(id), { keepPrevious: false })
  const d = resource.data
  return (
    <Screen title="Check out">
      {!d ? (
        <Fallback error={resource.error} onRetry={resource.reload} what="booking" back={{ to: '/m', label: 'Back to today' }} loading={<ScreenSkeleton />} />
      ) : d.booking.status !== 'checked_in' ? (
        <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">This stay is {d.booking.status.replace('_', ' ')}; nothing to check out.</p>
      ) : (
        <div className="rounded-[26px] bg-card p-4 shadow-card">
          <CheckOutForm
            booking={d.booking}
            save={(details) => booking.checkOut(d.booking.id, details)}
            onDone={() => {
              toast({ title: `Checked out ${d.booking.guestName}`, description: d.booking.unitCode })
              navigate('/m', { replace: true })
            }}
          />
        </div>
      )}
    </Screen>
  )
}
