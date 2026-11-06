import { useState } from 'react'
import { Link } from 'react-router'
import { Copy, ShieldCheck } from 'lucide-react'
import type { PreCheckInView } from '@/application/messaging'
import { ID_TYPE_LABEL } from '@/domain/guest'
import { PRECHECKIN_STATUS_LABEL, SEX_LABEL, VISA_LABEL } from '@/domain/precheckin'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { useToast } from '../../ui/useToast'
import { AttachmentList } from '../shared/Attachments'
import { PRECHECKIN_TONE } from '../messages/tones'

/** What the guest sent before arrival, checked against the ID; verify copies it onto the guest and the stay. */
export function PreCheckInDetails({ view, onVerified }: { view: PreCheckInView; onVerified: () => void }) {
  const { precheckin } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const r = view.record

  async function verify() {
    setBusy(true)
    try {
      await precheckin.verify(view.booking.id)
      toast({ title: `Verified ${view.booking.guestName}`, description: 'The guest profile and the stay carry the data; the check-in form is prefilled.' })
      onVerified()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not verify', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  if (!r) return <p className="text-sm text-muted">The guest has not filled in the online check-in yet. Send the pre-arrival message or copy the link.</p>
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        Arrives {r.arrivalTime}
        {r.flight && ` on ${r.flight}`} · {plural(r.adults, 'adult')}
        {r.children > 0 && `, ${r.children} ${r.children === 1 ? 'child' : 'children'}`} · {r.phone}
      </p>
      <ul className="space-y-2">
        {r.travellers.map((t, i) => (
          <li key={i} className="rounded-panel bg-raised p-3">
            <p className="font-medium">{t.name}</p>
            <p className="text-xs text-muted">
              {t.nationality} · {ID_TYPE_LABEL[t.documentType]} <span className="font-mono">{t.documentNumber}</span>
              {t.documentExpiry && ` · expires ${shortDay(t.documentExpiry)}`} · born {t.dateOfBirth ? shortDay(t.dateOfBirth) : 'not given'} · {SEX_LABEL[t.sex]}
            </p>
            {t.entryDate && (
              <p className="text-xs text-muted">
                Entered {shortDay(t.entryDate)} at {t.portOfEntry} · {VISA_LABEL[t.visaType]}
              </p>
            )}
          </li>
        ))}
      </ul>
      <AttachmentList files={r.idPhotos} />
      <p className="text-xs text-muted">
        House rules signed by <span className="italic">{r.rulesName}</span> on {shortDay(r.submittedAt.slice(0, 10))}
        {r.verifiedBy && `. Verified by ${r.verifiedBy} on ${shortDay((r.verifiedAt ?? '').slice(0, 10))}.`}
      </p>
      {r.status === 'submitted' && view.booking.status === 'confirmed' && can('booking', 'edit') && (
        <Button variant="accent" size="sm" loading={busy} onClick={() => void verify()}>
          {!busy && <ShieldCheck aria-hidden className="size-3.5" />} Verify against the ID
        </Button>
      )}
    </div>
  )
}

/** The booking page card: status, the guest's link and what they sent. */
export function PreCheckInCard({ view, onChanged }: { view: PreCheckInView; onChanged: () => void }) {
  const toast = useToast()
  const live = view.booking.status === 'confirmed' || view.booking.status === 'draft'
  return (
    <Card aria-labelledby="pc-title">
      <CardHeader id="pc-title" title="Online check-in" action={<StatusPill tone={PRECHECKIN_TONE[view.status]}>{PRECHECKIN_STATUS_LABEL[view.status]}</StatusPill>} />
      {live && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="soft"
            onClick={() => {
              void navigator.clipboard?.writeText(view.url)
              toast({ title: 'Link copied', description: view.url })
            }}
          >
            <Copy aria-hidden className="size-3.5" /> Copy link
          </Button>
          <Link to={view.path} className="inline-flex items-center text-sm text-accent-text hover:underline">
            Open the guest’s page
          </Link>
        </div>
      )}
      <PreCheckInDetails view={view} onVerified={onChanged} />
    </Card>
  )
}
