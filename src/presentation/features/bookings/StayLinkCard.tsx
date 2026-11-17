import { useState } from 'react'
import { Link } from 'react-router'
import { Copy, ExternalLink, Link2 } from 'lucide-react'
import type { BookingView } from '@/application/views'
import { localPath, stayUrl } from '@/domain/messaging'
import { GUEST_ACTION_LABEL, stayLinkExpiresOn, stayLinkState } from '@/domain/stay'
import { shortDay } from '@/lib/dates'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'
import { QrCode } from '../payments/QrCode'

const STATE_LABEL = { open: 'Open', read_only: 'Read only', expired: 'Closed' } as const
const STATE_TONE = { open: 'success', read_only: 'info', expired: 'neutral' } as const

/** The guest's stay page: the link with Copy and a QR code, and what the guest did from it. */
export function StayLinkCard({ booking: b, today, onChanged }: { booking: BookingView; today: string; onChanged: () => void }) {
  const { stay } = useServices()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (b.status !== 'checked_in' && !b.stayToken) return null
  const state = b.stayToken ? stayLinkState(b, today) : null
  const url = b.stayToken ? stayUrl(b.stayToken) : null
  const actions = [...(b.guestActions ?? [])].reverse()

  async function issue() {
    setBusy(true)
    try {
      await stay.issueLink(b.id)
      toast({ title: 'Made the stay link' })
      onChanged()
    } catch (e) {
      toast({ tone: 'danger', title: 'Could not make the stay link', description: Object.values(fieldErrors(e))[0] })
    } finally {
      setBusy(false)
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: 'Copied the stay link' })
    } catch {
      toast({ tone: 'danger', title: 'Could not copy the link', description: 'Select the link and copy it by hand.' })
    }
  }

  return (
    <Card aria-labelledby="stay-link-title">
      <CardHeader id="stay-link-title" title="Guest stay page" icon={<Link2 aria-hidden className="size-5 text-muted" />} action={state && <Tag tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Tag>} />
      {url ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <QrCode payload={url} className="size-28 shrink-0 border border-line" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm text-muted">The guest asks for cleaning, orders, sees the bill and asks for a late check-out here. It opens until {shortDay(stayLinkExpiresOn(b))}, read only after check-out.</p>
            <p className="truncate rounded-panel bg-raised px-3 py-2 font-mono text-xs">{url}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="solid" size="sm" onClick={() => void copy(url)}>
                <Copy aria-hidden className="size-4" /> Copy
              </Button>
              <Link to={localPath(url) ?? url} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-4 text-sm font-medium hover:bg-hover">
                <ExternalLink aria-hidden className="size-4" /> Open as the guest
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">This stay checked in before stay pages existed.</p>
          <Button variant="accent" size="sm" loading={busy} onClick={() => void issue()}>
            Make the stay link
          </Button>
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="text-xs font-semibold tracking-wider text-muted uppercase">From the guest</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {actions.map((a, i) => (
              <li key={i} className="flex items-start gap-3 py-2">
                <span className="min-w-0 flex-1">
                  {a.summary}
                  <span className="block text-xs text-muted">
                    Asked by the guest {a.at.slice(0, 10) === today ? 'at' : `on ${shortDay(a.at.slice(0, 10))} at`} {a.at.slice(11, 16)}
                  </span>
                </span>
                <Tag tone="neutral">{GUEST_ACTION_LABEL[a.kind]}</Tag>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
