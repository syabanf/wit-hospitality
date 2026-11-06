import { useNavigate, useParams } from 'react-router'
import { MinibarCheckForm } from '../stock/MinibarCheck'
import { Screen } from './Screen'

/** The minibar check on the phone: tap what the guest took, it bills to the stay. */
export function MinibarScreen() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  return (
    <Screen title="Minibar check">
      <section className="rounded-[26px] bg-card p-4 shadow-card" aria-label="Minibar">
        <MinibarCheckForm bookingId={id} onDone={() => void navigate(`/m/bookings/${id}`)} />
      </section>
    </Screen>
  )
}
