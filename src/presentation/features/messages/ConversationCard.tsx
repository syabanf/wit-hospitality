import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { FileText, Send } from 'lucide-react'
import { CHANNEL_LABEL, LANGUAGE_LABEL, MESSAGE_CHANNELS, MESSAGE_LANGUAGES, PLACEHOLDERS, type MessageChannel, type MessageLanguage, type TemplateKey } from '@/domain/messaging'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { MessageLog } from './parts'

/** The stay's conversation with its guest: send a template or a free message, see every message, resend a failed one. */
export function ConversationCard({ bookingId }: { bookingId: string }) {
  const { messaging } = useServices()
  const toast = useToast()
  const data = useResource(`messaging.forBooking:${bookingId}`, () => messaging.forBooking(bookingId), { keepPrevious: false })
  const [composing, setComposing] = useState(false)
  const [template, setTemplate] = useState<TemplateKey | ''>('')
  const [channel, setChannel] = useState<MessageChannel | null>(null)
  const [language, setLanguage] = useState<MessageLanguage | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)

  const d = data.data
  if (!d) return <CardSkeleton lines={3} />
  const picked = d.templates.find((t) => t.key === template)
  const lang = language ?? d.language
  const via = channel ?? picked?.channel ?? 'whatsapp'

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSending(true)
    setErrors({})
    try {
      const m = await messaging.send({ bookingId, channel: via, templateKey: template || null, language: lang, body: String(new FormData(e.currentTarget).get('body') ?? '') })
      toast({ tone: m.status === 'failed' ? 'danger' : undefined, title: m.status === 'failed' ? 'The message failed' : `Sent on ${CHANNEL_LABEL[m.channel]}`, description: m.status === 'failed' ? m.error : m.to })
      setComposing(false)
      setTemplate('')
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <Card aria-labelledby="msg-title">
      <CardHeader
        id="msg-title"
        title="Guest messages"
        action={
          <>
            <Link to={d.invoice.path} className={buttonStyles({ variant: 'soft', size: 'sm' })} title={d.invoice.url}>
              <FileText aria-hidden className="size-3.5" /> E-invoice
            </Link>
            {d.canSend && (
              <Button size="sm" variant="solid" aria-pressed={composing} onClick={() => setComposing((v) => !v)}>
                <Send aria-hidden className="size-3.5" /> Message
              </Button>
            )}
          </>
        }
      />
      {composing && (
        <form onSubmit={(e) => void send(e)} className="mb-4 space-y-3 rounded-panel bg-raised p-3.5" aria-label={`Message ${d.booking.guestName}`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Template" htmlFor="msg-template">
              <Select id="msg-template" className="w-full" value={template} options={[{ value: '', label: 'Free message' }, ...d.templates.map((t) => ({ value: t.key, label: t.name }))]} onChange={(e) => setTemplate(e.target.value as TemplateKey | '')} />
            </Field>
            <Field label="Channel" htmlFor="msg-channel" error={errors.channel}>
              <Select id="msg-channel" className="w-full" value={via} options={MESSAGE_CHANNELS.map((c) => ({ value: c, label: `${CHANNEL_LABEL[c]} · ${c === 'whatsapp' ? d.booking.guest.phone || 'no number' : d.booking.guest.email || 'no email'}` }))} onChange={(e) => setChannel(e.target.value as MessageChannel)} />
            </Field>
            <Field label="Language" htmlFor="msg-lang">
              <Select id="msg-lang" className="w-full" value={lang} options={MESSAGE_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABEL[l] }))} onChange={(e) => setLanguage(e.target.value as MessageLanguage)} />
            </Field>
          </div>
          {picked ? (
            <p className="rounded-panel bg-card p-3 text-sm whitespace-pre-line text-body">{picked.body[lang]}</p>
          ) : (
            <Field label="Message" htmlFor="msg-body" error={errors.body} hint={`You can use ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`}>
              <Textarea id="msg-body" name="body" rows={3} placeholder={`Hi {guest}, ...`} />
            </Field>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="accent" loading={sending}>
              {!sending && <Send aria-hidden className="size-4" />} Send
            </Button>
            <Button variant="soft" onClick={() => setComposing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <MessageLog messages={d.messages} canSend={d.canSend} onChanged={data.reload} empty="No message to this guest for the stay yet." />
    </Card>
  )
}

/** Every message to one guest across their stays, for the guest profile. */
export function GuestMessagesCard({ guestId }: { guestId: string }) {
  const { messaging } = useServices()
  const data = useResource(`messaging.forGuest:${guestId}`, () => messaging.forGuest(guestId), { keepPrevious: false })
  return (
    <Card aria-labelledby="guest-msg-title">
      <CardHeader id="guest-msg-title" title="Messages" />
      {data.data ? <MessageLog messages={data.data} canSend={false} onChanged={data.reload} showStay empty="No message to this guest yet." /> : <CardSkeleton lines={2} />}
    </Card>
  )
}
