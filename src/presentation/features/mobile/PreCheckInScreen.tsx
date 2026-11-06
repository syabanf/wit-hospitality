import { Link, useParams } from 'react-router'
import { LogIn } from 'lucide-react'
import { PRECHECKIN_STATUS_LABEL } from '@/domain/precheckin'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Fallback } from '../../ui/Gate'
import { PreCheckInDetails } from '../checkin/PreCheckInCard'
import { PRECHECKIN_TONE } from '../messages/tones'
import { Screen, ScreenSkeleton } from './Screen'

/** The guest's online check-in on the phone: what they sent, verify against the ID, then check in. */
export function PreCheckInScreen() {
  const { id = '' } = useParams()
  const { precheckin } = useServices()
  const resource = useResource(`precheckin.forBooking:${id}`, () => precheckin.forBooking(id), { keepPrevious: false })
  const v = resource.data
  return (
    <Screen title="Online check-in">
      {!v ? (
        <Fallback error={resource.error} onRetry={resource.reload} what="booking" back={{ to: '/m', label: 'Back to today' }} loading={<ScreenSkeleton />} />
      ) : (
        <div className="space-y-3">
          <div className="rounded-[26px] bg-card p-4 shadow-card">
            <div className="mb-3 flex items-center gap-3">
              <p className="min-w-0 flex-1 truncate font-semibold">{v.booking.guestName}</p>
              <StatusPill tone={PRECHECKIN_TONE[v.status]}>{PRECHECKIN_STATUS_LABEL[v.status]}</StatusPill>
            </div>
            <PreCheckInDetails view={v} onVerified={resource.reload} />
          </div>
          {v.status === 'verified' && v.booking.status === 'confirmed' && (
            <Link to={`/m/bookings/${v.booking.id}/check-in`} className={buttonStyles({ variant: 'accent', className: 'w-full' })}>
              <LogIn aria-hidden className="size-4" /> Check in
            </Link>
          )}
        </div>
      )}
    </Screen>
  )
}
