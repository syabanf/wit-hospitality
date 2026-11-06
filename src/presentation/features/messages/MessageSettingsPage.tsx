import { useState, type FormEvent } from 'react'
import { CHANNEL_LABEL, LANGUAGE_LABEL, MESSAGE_CHANNELS, MESSAGE_LANGUAGES, PLACEHOLDERS, TRIGGER_LABEL, type MessageChannel, type MessageTemplate, type MessagingSettings } from '@/domain/messaging'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'

/**
 * The guest message templates: each trigger on or off, its channel and its English and Indonesian text,
 * the pre-arrival lead time and the WiFi each villa's welcome message gives.
 */
export default function MessageSettingsPage() {
  const { messaging } = useServices()
  const toast = useToast()
  const data = useResource('messaging.settings', () => messaging.settings())
  const [draft, setDraft] = useState<MessagingSettings | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { villas, canEdit } = data.data
  const s = draft ?? data.data.settings
  const setTemplate = (key: MessageTemplate['key'], change: Partial<MessageTemplate>) => setDraft({ ...s, templates: s.templates.map((t) => (t.key === key ? { ...t, ...change } : t)) })

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      await messaging.saveSettings(s)
      setDraft(null)
      data.reload()
      toast({ title: 'Templates saved', description: 'Triggers use them from the next message.' })
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card aria-labelledby="timing-title">
          <CardHeader id="timing-title" title="Timing" />
          <Field label="Pre-arrival message, days before check-in" htmlFor="pre-days" error={errors.preArrivalDays} hint="Goes at 10:00 with the online check-in link. The checkout reminder goes at 18:00 the evening before departure.">
            <Input id="pre-days" type="number" inputMode="numeric" min={1} max={14} className="tabular" disabled={!canEdit} value={s.preArrivalDays} onChange={(e) => setDraft({ ...s, preArrivalDays: Number(e.target.value) })} />
          </Field>
          <p className="mt-4 text-sm text-muted">
            Messages go through the provider port. The demo queues each one, marks it sent, then delivered; a WhatsApp gateway such as Fonnte, Qontak or the WhatsApp Cloud API plugs in there.
          </p>
        </Card>
        <Card aria-labelledby="wifi-title">
          <CardHeader id="wifi-title" title="WiFi in the welcome message" />
          <div className="space-y-3">
            {villas.map((v) => (
              <Field key={v.id} label={v.name} htmlFor={`wifi-${v.id}`}>
                <Input id={`wifi-${v.id}`} disabled={!canEdit} value={s.wifi[v.id] ?? ''} placeholder="Network / password" onChange={(e) => setDraft({ ...s, wifi: { ...s.wifi, [v.id]: e.target.value } })} />
              </Field>
            ))}
          </div>
        </Card>
      </div>
      <p className="text-sm text-muted">Placeholders: {PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}. Switching a template off stops the automatic send; staff can still send it from the booking.</p>
      {s.templates.map((t) => (
        <Card key={t.key} aria-labelledby={`tpl-${t.key}`}>
          <CardHeader
            id={`tpl-${t.key}`}
            title={t.name}
            action={
              <>
                <Select aria-label={`${t.name} channel`} disabled={!canEdit} value={t.channel} options={MESSAGE_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} onChange={(e) => setTemplate(t.key, { channel: e.target.value as MessageChannel })} />
                <Switch label={`Send ${t.name} automatically`} disabled={!canEdit} checked={t.enabled} onChange={(on) => setTemplate(t.key, { enabled: on })} />
              </>
            }
          />
          <p className="-mt-2 mb-3 text-xs text-muted">{TRIGGER_LABEL[t.key]}</p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {MESSAGE_LANGUAGES.map((lang) => (
              <div key={lang} className="space-y-2">
                {t.channel === 'email' && (
                  <Field label={`Subject, ${LANGUAGE_LABEL[lang]}`} htmlFor={`${t.key}-subject-${lang}`}>
                    <Input id={`${t.key}-subject-${lang}`} disabled={!canEdit} value={t.subject[lang]} onChange={(e) => setTemplate(t.key, { subject: { ...t.subject, [lang]: e.target.value } })} />
                  </Field>
                )}
                <Field label={LANGUAGE_LABEL[lang]} htmlFor={`${t.key}-${lang}`} error={errors[`${t.key}.${lang}`]}>
                  <Textarea id={`${t.key}-${lang}`} rows={4} disabled={!canEdit} value={t.body[lang]} onChange={(e) => setTemplate(t.key, { body: { ...t.body, [lang]: e.target.value } })} />
                </Field>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {canEdit && (
        <div className="sticky bottom-4 flex gap-2">
          <Button type="submit" variant="accent" loading={saving} disabled={!draft}>
            Save templates
          </Button>
          <Button variant="soft" disabled={!draft} onClick={() => setDraft(null)}>
            Reset
          </Button>
        </div>
      )}
    </form>
  )
}
