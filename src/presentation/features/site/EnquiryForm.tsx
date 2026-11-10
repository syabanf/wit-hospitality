import { useId, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { MAX_PARTY, type EnquiryInput } from '@/domain/enquiry'
import { COUNTRY_OPTIONS } from '@/domain/guest'
import { addDays } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { useServices } from '../../hooks/useServices'
import { fieldErrors } from '../../ui/fieldErrors'
import { solidButton } from './parts'

export interface EnquiryOptions {
  today: string
  villas: ReadonlyArray<{ id: string; name: string }>
  roomTypes: ReadonlyArray<{ id: string; villaId: string; name: string }>
}

/** Where the thanks page reads what was sent: the reference and stay only, never the guest's details. */
export interface EnquirySent {
  number: string
  villaName: string
  checkIn: string
  checkOut: string
  firstName: string
}

function Row({ id, label, error, children, className }: { id: string; label: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="s-label text-(--s-muted)">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-(--s-terra)">
          {error}
        </p>
      )}
    </div>
  )
}

/** The request to book: contact, dates, party and villa. It creates a web enquiry the team answers. */
export function EnquiryForm({ options, initial }: { options: EnquiryOptions; initial?: Partial<EnquiryInput> }) {
  const { site } = useServices()
  const navigate = useNavigate()
  const id = useId()
  const [v, setV] = useState<EnquiryInput>({
    name: '',
    email: '',
    whatsapp: '',
    country: '',
    checkIn: initial?.checkIn || addDays(options.today, 14),
    checkOut: initial?.checkOut || addDays(options.today, 17),
    guests: initial?.guests ?? 2,
    villaId: initial?.villaId ?? options.villas[0]?.id ?? '',
    groupId: initial?.groupId ?? null,
    note: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<EnquiryInput>) => setV((x) => ({ ...x, ...patch }))
  const types = options.roomTypes.filter((t) => t.villaId === v.villaId)
  const field = (name: keyof EnquiryInput) => ({ id: `${id}-${name}`, 'aria-invalid': errors[name] ? true : undefined, 'aria-describedby': errors[name] ? `${id}-${name}-error` : undefined })

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    try {
      const receipt = await site.enquire(v)
      const sent: EnquirySent = { ...receipt, firstName: v.name.trim().split(/\s+/)[0] ?? '' }
      navigate('/stay/thanks', { state: sent })
    } catch (error) {
      setErrors(fieldErrors(error))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={send} noValidate className="grid gap-x-8 gap-y-6 sm:grid-cols-2" aria-label="Request to book">
      <Row id={`${id}-name`} label="Full name" error={errors.name}>
        <input {...field('name')} className="s-field" autoComplete="name" value={v.name} onChange={(e) => set({ name: e.target.value })} required />
      </Row>
      <Row id={`${id}-email`} label="Email" error={errors.email}>
        <input {...field('email')} type="email" className="s-field" autoComplete="email" value={v.email} onChange={(e) => set({ email: e.target.value })} required />
      </Row>
      <Row id={`${id}-whatsapp`} label="WhatsApp, with country code" error={errors.whatsapp}>
        <input {...field('whatsapp')} type="tel" className="s-field" autoComplete="tel" placeholder="+44 7700 900 123" value={v.whatsapp} onChange={(e) => set({ whatsapp: e.target.value })} required />
      </Row>
      <Row id={`${id}-country`} label="Country" error={errors.country}>
        <select {...field('country')} className="s-field" autoComplete="country" value={v.country} onChange={(e) => set({ country: e.target.value })} required>
          <option value="">Pick your country</option>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Row>
      <Row id={`${id}-checkIn`} label="Check-in" error={errors.checkIn}>
        <input {...field('checkIn')} type="date" className="s-field" min={options.today} value={v.checkIn} onChange={(e) => set({ checkIn: e.target.value, checkOut: v.checkOut > e.target.value ? v.checkOut : addDays(e.target.value, 3) })} required />
      </Row>
      <Row id={`${id}-checkOut`} label="Check-out" error={errors.checkOut}>
        <input {...field('checkOut')} type="date" className="s-field" min={v.checkIn ? addDays(v.checkIn, 1) : options.today} value={v.checkOut} onChange={(e) => set({ checkOut: e.target.value })} required />
      </Row>
      <Row id={`${id}-villaId`} label="Villa" error={errors.villaId}>
        <select {...field('villaId')} className="s-field" value={v.villaId} onChange={(e) => set({ villaId: e.target.value, groupId: null })}>
          {options.villas.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Row>
      <Row id={`${id}-groupId`} label="Room type" error={errors.groupId}>
        <select {...field('groupId')} className="s-field" value={v.groupId ?? ''} onChange={(e) => set({ groupId: e.target.value || null })}>
          <option value="">Any in this villa</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Row>
      <Row id={`${id}-guests`} label="Guests" error={errors.guests}>
        <input {...field('guests')} type="number" inputMode="numeric" min={1} max={MAX_PARTY} className="s-field" value={v.guests} onChange={(e) => set({ guests: Number(e.target.value) })} />
      </Row>
      <Row id={`${id}-note`} label="Anything we should know" error={errors.note} className="sm:col-span-2">
        <textarea {...field('note')} rows={3} className="s-field resize-y" value={v.note} onChange={(e) => set({ note: e.target.value })} placeholder="Arrival time, a celebration, an airport car" />
      </Row>
      {errors.form && (
        <p role="alert" className="text-sm text-(--s-terra) sm:col-span-2">
          {errors.form}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        <button type="submit" className={cn(solidButton)} disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Sending' : 'Send request'}
          <ArrowRight aria-hidden className="size-4" />
        </button>
        <p className="max-w-sm text-xs text-(--s-muted)">Nothing is charged now. We hold no room until we confirm with you by WhatsApp or email.</p>
      </div>
    </form>
  )
}
