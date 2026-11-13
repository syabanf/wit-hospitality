import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { CircleCheck, ClipboardCheck, Send, Wallet } from 'lucide-react'
import { ID_TYPE_LABEL, type IdType } from '@/domain/guest'
import { GATEWAY_METHODS, PAYMENT_METHOD_LABEL, type PaymentMethod } from '@/domain/payment'
import { emptyTraveller, isIndonesian, SEX_LABEL, VISA_LABEL, VISA_TYPES, type PreCheckInInput, type Sex, type TravellerDocument, type VisaType } from '@/domain/precheckin'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState } from '../../ui/States'
import { AttachmentPicker } from '../shared/Attachments'

const SECTION = 'rounded-card border border-line bg-card p-5 shadow-card'

/** One adult's document; foreign guests also give their entry date, port and visa. */
function TravellerFields({ index, value, errors, onChange, disabled }: { index: number; value: TravellerDocument; errors: Record<string, string>; onChange: (t: TravellerDocument) => void; disabled: boolean }) {
  const id = (f: string) => `t${index}-${f}`
  const err = (f: keyof TravellerDocument) => errors[`travellers.${index}.${f}`]
  const set = (change: Partial<TravellerDocument>) => onChange({ ...value, ...change })
  const foreign = !isIndonesian(value.nationality)
  return (
    <fieldset className="space-y-3 rounded-panel bg-raised p-4" disabled={disabled}>
      <legend className="sr-only">Adult {index + 1}</legend>
      <p className="text-sm font-semibold">{index === 0 ? 'Lead guest' : `Adult ${index + 1}`}</p>
      <Field label="Full name as on the document" htmlFor={id('name')} error={err('name')}>
        <Input id={id('name')} tone="card" value={value.name} autoComplete={index === 0 ? 'name' : 'off'} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nationality" htmlFor={id('nat')} error={err('nationality')}>
          <Input id={id('nat')} tone="card" value={value.nationality} onChange={(e) => set({ nationality: e.target.value, ...(isIndonesian(e.target.value) ? { documentType: 'ktp' as const, visaType: 'none' as const } : {}) })} />
        </Field>
        <Field label="Sex" htmlFor={id('sex')}>
          <Select id={id('sex')} tone="card" className="w-full" value={value.sex} options={(Object.keys(SEX_LABEL) as Sex[]).map((s) => ({ value: s, label: SEX_LABEL[s] }))} onChange={(e) => set({ sex: e.target.value as Sex })} />
        </Field>
        <Field label="Document" htmlFor={id('type')}>
          <Select id={id('type')} tone="card" className="w-full" value={value.documentType} options={(Object.keys(ID_TYPE_LABEL) as IdType[]).map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} onChange={(e) => set({ documentType: e.target.value as IdType })} />
        </Field>
        <Field label="Document number" htmlFor={id('no')} error={err('documentNumber')}>
          <Input id={id('no')} tone="card" className="font-mono" value={value.documentNumber} onChange={(e) => set({ documentNumber: e.target.value })} />
        </Field>
        <Field label="Date of birth" htmlFor={id('dob')} error={err('dateOfBirth')}>
          <Input id={id('dob')} tone="card" type="date" value={value.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} />
        </Field>
        {value.documentType === 'passport' && (
          <Field label="Passport expiry" htmlFor={id('exp')} error={err('documentExpiry')}>
            <Input id={id('exp')} tone="card" type="date" value={value.documentExpiry} onChange={(e) => set({ documentExpiry: e.target.value })} />
          </Field>
        )}
      </div>
      {foreign && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entry into Indonesia" htmlFor={id('entry')} error={err('entryDate')}>
            <Input id={id('entry')} tone="card" type="date" value={value.entryDate} onChange={(e) => set({ entryDate: e.target.value })} />
          </Field>
          <Field label="Visa" htmlFor={id('visa')} error={err('visaType')}>
            <Select id={id('visa')} tone="card" className="w-full" value={value.visaType} options={VISA_TYPES.map((v) => ({ value: v, label: VISA_LABEL[v] }))} onChange={(e) => set({ visaType: e.target.value as VisaType })} />
          </Field>
          <Field label="Airport or port of entry" htmlFor={id('port')} error={err('portOfEntry')} className="col-span-2">
            <Input id={id('port')} tone="card" value={value.portOfEntry} placeholder="Ngurah Rai International Airport (DPS)" onChange={(e) => set({ portOfEntry: e.target.value })} />
          </Field>
        </div>
      )}
    </fieldset>
  )
}

/**
 * The guest's online check-in from the pre-arrival message. No sign-in: the signed token is the key.
 * The guest confirms contact and arrival, gives every adult's ID, uploads a photo, signs the house rules
 * and can pay the balance; the front desk verifies it against the ID on arrival.
 */
export default function PreCheckInPage() {
  const { token = '' } = useParams()
  const { precheckin } = useServices()
  const navigate = useNavigate()
  const data = useResource(`precheckin.guest:${token}`, () => precheckin.guest(token), { keepPrevious: false })
  const [draft, setDraft] = useState<PreCheckInInput | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'send' | 'pay' | null>(null)
  const [sent, setSent] = useState(false)
  const [method, setMethod] = useState<PaymentMethod>('qris')

  const p = data.data
  const f = draft ?? p?.form
  const set = (change: Partial<PreCheckInInput>) => f && setDraft({ ...f, ...change })
  const setAdults = (n: number) => {
    if (!f) return
    const count = Math.max(1, Math.min(12, n || 1))
    set({ adults: count, travellers: Array.from({ length: count }, (_, i) => f.travellers[i] ?? emptyTraveller('', f.travellers[0]?.nationality ?? '')) })
  }

  async function send() {
    if (!f) return
    setBusy('send')
    setErrors({})
    try {
      data.setData(await precheckin.submit(token, f))
      setDraft(null)
      setSent(true)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e) {
      setErrors(fieldErrors(e))
    } finally {
      setBusy(null)
    }
  }

  async function pay() {
    setBusy('pay')
    setErrors({})
    try {
      const link = await precheckin.payBalance(token, method)
      navigate(`/pay/${link.token}`)
    } catch (e) {
      setErrors(fieldErrors(e))
      setBusy(null)
    }
  }

  const problems = Object.keys(errors).length
  return (
    <div className="min-h-dvh bg-canvas px-[max(env(safe-area-inset-left),1rem)] pt-[max(env(safe-area-inset-top),1.5rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)]">
      <div className="mx-auto w-full max-w-xl space-y-4">
        <header className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <BrandMark className="size-7 text-fg" />
            <span className="text-sm font-bold tracking-tight">{p?.villaName ?? 'Bali Villas'}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <ClipboardCheck aria-hidden className="size-4" /> Online check-in
          </span>
        </header>
        {!p && data.status === 'error' && (
          <EmptyState title="This check-in link does not work">{data.error.message.includes('closed') ? data.error.message : 'Ask your host to send it again.'}</EmptyState>
        )}
        {!p && data.status !== 'error' && <CardSkeleton lines={6} />}
        {p && f && (
          <main className="animate-rise space-y-4">
            <section className={SECTION}>
              <h1 className="text-2xl font-semibold tracking-tight">
                Hello {p.guestName.split(' ')[0]}
                <span className="text-accent">.</span>
              </h1>
              <p className="mt-1 text-sm text-muted">
                {p.unitName} · {p.villaName}, {p.locationName}
              </p>
              <p className="text-sm text-muted">
                {shortDay(p.checkIn)} to {shortDay(p.checkOut)} · {plural(p.nights, 'night')} · {p.bookingCode}
              </p>
              {p.checkInTime && p.checkOutTime && (
                <p className="text-sm text-muted">
                  Check-in from {p.checkInTime}, check-out by {p.checkOutTime}
                </p>
              )}
              {!p.editable && (
                <p className="mt-3 rounded-panel bg-info-soft p-3 text-sm text-body">
                  {p.status === 'verified' ? 'The front desk verified your details. See you soon.' : 'You are checked in. Enjoy your stay.'}
                </p>
              )}
            </section>

            {(sent || p.status === 'submitted') && p.editable && (
              <section aria-live="polite" className="animate-pop-in flex items-center gap-3 rounded-card border border-line bg-card p-4 shadow-card">
                <CircleCheck aria-hidden className="size-8 shrink-0 text-success" />
                <p className="text-sm">Thank you, we have your details. The front desk checks your ID when you arrive; you can still change anything below until then.</p>
              </section>
            )}

            <section aria-labelledby="pc-contact" className={`${SECTION} space-y-3`}>
              <h2 id="pc-contact" className="font-semibold">Contact and arrival</h2>
              <fieldset disabled={!p.editable} className="grid grid-cols-2 gap-3">
                <Field label="Mobile (WhatsApp)" htmlFor="pc-phone" error={errors.phone}>
                  <Input id="pc-phone" tone="card" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
                </Field>
                <Field label="Email" htmlFor="pc-email" error={errors.email}>
                  <Input id="pc-email" tone="card" type="email" autoComplete="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
                </Field>
                <Field label="Expected arrival" htmlFor="pc-time" error={errors.arrivalTime} hint={`Check-in from ${p.checkInTime ?? '14:00'}`}>
                  <Input id="pc-time" tone="card" type="time" value={f.arrivalTime} onChange={(e) => set({ arrivalTime: e.target.value })} />
                </Field>
                <Field label="Flight" htmlFor="pc-flight" hint="Optional, for the transfer">
                  <Input id="pc-flight" tone="card" value={f.flight} placeholder="GA 404" onChange={(e) => set({ flight: e.target.value })} />
                </Field>
                <Field label="Adults" htmlFor="pc-adults" error={errors.adults ?? errors.travellers}>
                  <Input id="pc-adults" tone="card" type="number" inputMode="numeric" min={1} max={12} className="tabular" value={f.adults} onChange={(e) => setAdults(Number(e.target.value))} />
                </Field>
                <Field label="Children" htmlFor="pc-children" error={errors.children}>
                  <Input id="pc-children" tone="card" type="number" inputMode="numeric" min={0} max={12} className="tabular" value={f.children} onChange={(e) => set({ children: Number(e.target.value) || 0 })} />
                </Field>
              </fieldset>
            </section>

            <section aria-labelledby="pc-ids" className={`${SECTION} space-y-3`}>
              <h2 id="pc-ids" className="font-semibold">ID of every adult</h2>
              <p className="text-sm text-muted">Indonesian law asks us to register every adult guest. Foreign guests add their entry stamp and visa.</p>
              {f.travellers.map((t, i) => (
                <TravellerFields key={i} index={i} value={t} errors={errors} disabled={!p.editable} onChange={(next) => set({ travellers: f.travellers.map((x, j) => (j === i ? next : x)) })} />
              ))}
              <div>
                <p className="mb-2 text-sm font-medium">Photo of the lead guest’s passport or KTP</p>
                <AttachmentPicker
                  id="pc-photo"
                  value={f.idPhotos}
                  removable={p.editable}
                  hint="A clear photo of the page with your picture"
                  onChange={(files) => set({ idPhotos: files })}
                  upload={(file) => precheckin.upload(token, file)}
                />
                {errors.idPhotos && <p role="alert" className="mt-1 text-xs font-medium text-danger">{errors.idPhotos}</p>}
              </div>
            </section>

            <section aria-labelledby="pc-rules" className={`${SECTION} space-y-3`}>
              <h2 id="pc-rules" className="font-semibold">House rules</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm text-body">
                {p.houseRules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <fieldset disabled={!p.editable} className="space-y-3">
                <Field label="Type your full name to sign" htmlFor="pc-sign" error={errors.rulesName}>
                  <Input id="pc-sign" tone="card" className="font-serif italic" value={f.rulesName} onChange={(e) => set({ rulesName: e.target.value })} />
                </Field>
                <label className={`flex items-start gap-3 rounded-panel bg-raised px-4 py-3 text-sm ${errors.rulesAccepted ? 'ring-1 ring-danger' : ''}`}>
                  <input type="checkbox" checked={f.rulesAccepted} onChange={(e) => set({ rulesAccepted: e.target.checked })} className="mt-0.5 size-4 shrink-0 accent-accent" />
                  <span className="font-medium">I have read the house rules and accept them for everyone in my party</span>
                </label>
                {errors.rulesAccepted && <p role="alert" className="text-xs font-medium text-danger">{errors.rulesAccepted}</p>}
              </fieldset>
            </section>

            {errors.form && (
              <p role="alert" className="rounded-panel bg-danger-soft p-3 text-sm font-medium text-danger">
                {errors.form}
              </p>
            )}
            {p.editable && (
              <Button variant="accent" className="w-full" loading={busy === 'send'} onClick={() => void send()}>
                {busy !== 'send' && <Send aria-hidden className="size-4" />} {p.status === 'not_started' ? 'Send my check-in' : 'Update my check-in'}
              </Button>
            )}
            {problems > 0 && !errors.form && <p role="alert" className="text-center text-xs font-medium text-danger">Check the {plural(problems, 'highlighted field')} above.</p>}

            {p.balance > 0 && (
              <section aria-labelledby="pc-pay" className={`${SECTION} space-y-3`}>
                <div className="flex items-center justify-between gap-3">
                  <h2 id="pc-pay" className="font-semibold">Pay the balance now</h2>
                  <span className="font-semibold tabular">{money(p.balance)}</span>
                </div>
                <p className="text-sm text-muted">Optional. Paying ahead means nothing to settle at the desk except extras.</p>
                {!p.payToken && (
                  <Select aria-label="How to pay" tone="card" className="w-full" value={method} options={GATEWAY_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} onChange={(e) => setMethod(e.target.value as PaymentMethod)} />
                )}
                <Button variant="solid" className="w-full" loading={busy === 'pay'} onClick={() => (p.payToken ? navigate(`/pay/${p.payToken}`) : void pay())}>
                  <Wallet aria-hidden className="size-4" /> {p.payToken ? 'Continue to payment' : `Pay ${money(p.balance)}`}
                </Button>
              </section>
            )}
          </main>
        )}
      </div>
    </div>
  )
}
