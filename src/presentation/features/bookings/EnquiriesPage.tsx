import { useState } from 'react'
import { Link } from 'react-router'
import { ExternalLink, Mail, MessageCircle } from 'lucide-react'
import type { EnquiryView } from '@/application/enquiries'
import { ENQUIRY_STATUS_LABEL, ENQUIRY_TOPIC_LABEL, isOwnerEnquiry, type EnquiryStatus } from '@/domain/enquiry'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, type Tone } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'

const TONE: Record<EnquiryStatus, Tone> = { new: 'warning', contacted: 'info', converted: 'success', closed: 'neutral' }
const HINT: Record<EnquiryStatus, string> = { new: 'Waiting for a reply', contacted: 'Answered, no booking yet', converted: 'Booked', closed: 'No booking' }

/** Requests to book from the public website: answer, convert into a booking, or close with a reason. */
export default function EnquiriesPage() {
  const { enquiries } = useServices()
  const data = useResource('enquiries.list', () => enquiries.list())
  const [chip, setChip] = useState<EnquiryStatus | 'all'>('all')

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const { list, counts, mayEdit } = data.data
  const shown = chip === 'all' ? list : list.filter((e) => e.status === chip)

  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(['new', 'contacted', 'converted', 'closed'] as const).map((s) => (
          <StatTile key={s} label={ENQUIRY_STATUS_LABEL[s]} value={counts[s]} hint={HINT[s]} active={chip === s} onClick={() => setChip(chip === s ? 'all' : s)} />
        ))}
      </div>
      <p className="text-sm text-muted">
        Guests send these from the{' '}
        <Link to="/stay" className="font-medium text-accent-text hover:underline">
          public site
        </Link>
        . Nothing is held until you book it. Villa owners asking about management are marked Villa owner and do not convert into a booking.
      </p>
      {shown.length === 0 && <EmptyState title="No enquiry here">Pick another tile.</EmptyState>}
      {shown.map((e) => (
        <EnquiryCard key={e.id} e={e} mayEdit={mayEdit} onChanged={data.reload} />
      ))}
    </div>
  )
}

function EnquiryCard({ e, mayEdit, onChanged }: { e: EnquiryView; mayEdit: boolean; onChanged: () => void }) {
  const { enquiries } = useServices()
  const toast = useToast()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'contacted' | 'closed' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const owner = isOwnerEnquiry(e)
  const convertible = !owner && (e.status === 'new' || e.status === 'contacted')

  async function move(status: 'contacted' | 'closed') {
    setBusy(status)
    setError(null)
    try {
      await enquiries.setStatus(e.id, status, note)
      toast({ title: `${e.number} ${ENQUIRY_STATUS_LABEL[status].toLowerCase()}` })
      setNote('')
      onChanged()
    } catch (err) {
      setError(Object.values(fieldErrors(err))[0] ?? 'Could not save.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card aria-labelledby={`enq-${e.id}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p id={`enq-${e.id}`} className="font-semibold">
            {e.name} <span className="font-mono text-xs font-normal text-muted">{e.number}</span>
          </p>
          <p className="text-xs text-muted">
            {owner ? (
              'About managing their villa'
            ) : (
              <>
                {e.villaName}
                {e.groupName && `, ${e.groupName}`} · {shortDay(e.checkIn)} to {shortDay(e.checkOut)} · {plural(e.nights, 'night')} · {plural(e.guests, 'guest')}
              </>
            )}{' '}
            · {e.countryName} · sent {shortDay(e.createdOn)}
          </p>
        </div>
        {owner && <StatusPill tone="info">{ENQUIRY_TOPIC_LABEL.owner}</StatusPill>}
        <StatusPill tone={TONE[e.status]}>{ENQUIRY_STATUS_LABEL[e.status]}</StatusPill>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <a href={`https://wa.me/${e.whatsapp.replace(/\D/g, '')}`} className="inline-flex items-center gap-1.5 text-accent-text hover:underline" target="_blank" rel="noopener noreferrer">
          <MessageCircle aria-hidden className="size-4" />
          {e.whatsapp}
        </a>
        <a href={`mailto:${e.email}`} className="inline-flex items-center gap-1.5 text-accent-text hover:underline">
          <Mail aria-hidden className="size-4" />
          {e.email}
        </a>
      </div>
      {e.note && <p className="mt-3 rounded-panel bg-raised px-3 py-2 text-sm text-body">“{e.note}”</p>}
      {e.handledBy && (
        <p className="mt-2 text-xs text-muted">
          {e.handledBy}: {e.statusNote || 'no note'}
        </p>
      )}
      {e.status === 'converted' && e.bookingId && (
        <Link to={`/bookings/${e.bookingId}`} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline">
          Booking {e.bookingCode ?? ''}
          <ExternalLink aria-hidden className="size-3.5" />
        </Link>
      )}
      {mayEdit && e.status !== 'converted' && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {convertible && (
            <Link to={`/bookings/new?enquiry=${e.id}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
              Convert to booking
            </Link>
          )}
          <Input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Note, needed to close" aria-label={`Note on ${e.number}`} className="h-10 min-w-48 flex-1" />
          {e.status !== 'contacted' && (
            <Button size="sm" loading={busy === 'contacted'} onClick={() => move('contacted')}>
              {e.status === 'closed' ? 'Pick up again' : 'Mark contacted'}
            </Button>
          )}
          {e.status !== 'closed' && (
            <Button size="sm" variant="ghost" loading={busy === 'closed'} onClick={() => move('closed')}>
              Close
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  )
}
