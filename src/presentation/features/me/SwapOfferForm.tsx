import { useState, type FormEvent } from 'react'
import type { Shift } from '@/domain/hr'
import { shortDay, type IsoDate } from '@/lib/dates'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

interface TeamRow {
  id: string
  name: string
  days: readonly { date: IsoDate; villaId: string | null; shift: Shift | null }[]
}

interface SwapOfferFormProps {
  me: TeamRow
  coworkers: readonly TeamRow[]
  today: IsoDate
  onDone: () => void
}

const GIVE = 'give'
const shiftLabel = (day: { date: IsoDate; shift: Shift | null }) => `${shortDay(day.date)} · ${day.shift?.name ?? ''} ${day.shift?.start ?? ''}`

/** Offers one of the employee's coming shifts to a coworker at the same villa, as a gift or against one of theirs. */
export function SwapOfferForm({ me, coworkers, today, onDone }: SwapOfferFormProps) {
  const { selfService } = useServices()
  const toast = useToast()
  const mine = me.days.filter((d) => d.shift && d.date > today)
  const [date, setDate] = useState(mine[0]?.date ?? '')
  const villaId = mine.find((d) => d.date === date)?.villaId ?? null
  const eligible = coworkers.filter((c) => c.id !== me.id)
  const [counterpartId, setCounterpartId] = useState(eligible[0]?.id ?? '')
  const [counterDate, setCounterDate] = useState(GIVE)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const theirs = eligible.find((c) => c.id === counterpartId)?.days.filter((d) => d.shift && d.date > today && d.villaId === villaId) ?? []

  if (mine.length === 0) return <p className="text-sm text-muted">You have no coming shifts to swap.</p>
  if (eligible.length === 0) return <p className="text-sm text-muted">No coworker shares your villa.</p>

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const note = String(new FormData(e.currentTarget).get('note') ?? '')
    setSaving(true)
    setErrors({})
    try {
      const swap = await selfService.requestSwap({ date, counterpartId, counterDate: counterDate === GIVE ? null : counterDate, note })
      toast({ title: `Offered ${swap.number}`, description: `${swap.counterpartName} accepts or declines it in their employee area` })
      setCounterDate(GIVE)
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="My shift" htmlFor="sw-date" error={errors.date}>
        <Select id="sw-date" className="w-full" value={date} options={mine.map((d) => ({ value: d.date, label: shiftLabel(d) }))} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Coworker" htmlFor="sw-who" error={errors.counterpartId}>
        <Select id="sw-who" className="w-full" value={counterpartId} options={eligible.map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => { setCounterpartId(e.target.value); setCounterDate(GIVE) }} />
      </Field>
      <Field label="In exchange" htmlFor="sw-counter" error={errors.counterDate} hint="Take one of their shifts back, or hand yours over">
        <Select id="sw-counter" className="w-full" value={counterDate} options={[{ value: GIVE, label: 'Nothing, hand it over' }, ...theirs.map((d) => ({ value: d.date, label: `Their ${shiftLabel(d)}` }))]} onChange={(e) => setCounterDate(e.target.value)} />
      </Field>
      <Field label="Note" htmlFor="sw-note" error={errors.note}>
        <Input id="sw-note" name="note" placeholder="Why you ask" />
      </Field>
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger sm:col-span-2">
          {errors.form}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" variant="accent" loading={saving}>
          Offer swap
        </Button>
      </div>
    </form>
  )
}
