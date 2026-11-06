import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import { Mail, MessageCircle, RotateCw } from 'lucide-react'
import type { MessageView } from '@/application/messaging'
import { CHANNEL_LABEL, canResend, localPath, MESSAGE_STATUS_LABEL } from '@/domain/messaging'
import { shortDay } from '@/lib/dates'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { useToast } from '../../ui/useToast'
import { MESSAGE_TONE } from './tones'

/** The text as the guest got it; links to the guest site open the same page here. */
export function MessageBody({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g)
  return (
    <p className={className}>
      {parts.map((part, i) => {
        const path = localPath(part)
        if (path) return <Link key={i} to={path} className="break-all text-accent-text underline">{part}</Link>
        if (/^https?:\/\//.test(part)) return <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all text-accent-text underline">{part}</a>
        return <Fragment key={i}>{part}</Fragment>
      })}
    </p>
  )
}

const clock = (at: string) => `${shortDay(at.slice(0, 10))} ${at.slice(11, 16)}`

/** A conversation log, newest first, with resend on a failed message when the person may send. */
export function MessageLog({ messages, canSend, onChanged, showStay = false, empty }: { messages: readonly MessageView[]; canSend: boolean; onChanged: () => void; showStay?: boolean; empty: string }) {
  const { messaging } = useServices()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  async function resend(m: MessageView) {
    setBusy(m.id)
    try {
      const next = await messaging.resend(m.id)
      toast({ tone: next.status === 'failed' ? 'danger' : undefined, title: next.status === 'failed' ? `${m.number} failed again` : `Resent ${m.number}`, description: next.status === 'failed' ? next.error : `${CHANNEL_LABEL[m.channel]} to ${next.to}` })
      onChanged()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not resend ${m.number}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (messages.length === 0) return <p className="text-sm text-muted">{empty}</p>
  return (
    <ol className="space-y-3">
      {messages.map((m) => {
        const Icon = m.channel === 'whatsapp' ? MessageCircle : Mail
        return (
          <li key={m.id} className="rounded-panel bg-raised p-3.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <Icon aria-hidden className="size-3.5" />
              <span className="font-medium text-fg">{m.templateName}</span>
              <span>·</span>
              <span>{CHANNEL_LABEL[m.channel]} to {m.to || 'no contact'}</span>
              {showStay && (
                <>
                  <span>·</span>
                  <Link to={`/bookings/${m.bookingId}`} className="font-mono hover:underline">{m.bookingCode}</Link>
                </>
              )}
              <StatusPill tone={MESSAGE_TONE[m.status]} className="ml-auto">{MESSAGE_STATUS_LABEL[m.status]}</StatusPill>
            </div>
            {m.subject && m.channel === 'email' && <p className="mt-2 text-sm font-medium">{m.subject}</p>}
            <MessageBody text={m.body} className="mt-1.5 text-sm whitespace-pre-line text-body" />
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{m.sentBy} · {clock(m.queuedAt)}{m.deliveredAt && ` · delivered ${m.deliveredAt.slice(11, 16)}`}{m.readAt && ` · read ${m.readAt.slice(11, 16)}`}{m.attempts > 1 && ` · attempt ${m.attempts}`}</span>
              {m.status === 'failed' && <span className="font-medium text-danger">{m.error}</span>}
              {canSend && canResend(m) && (
                <Button size="sm" variant="soft" className="ml-auto" loading={busy === m.id} onClick={() => void resend(m)}>
                  {busy !== m.id && <RotateCw aria-hidden className="size-3.5" />} Resend
                </Button>
              )}
            </p>
          </li>
        )
      })}
    </ol>
  )
}
