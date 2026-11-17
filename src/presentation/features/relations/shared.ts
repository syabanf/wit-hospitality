import { useState } from 'react'
import type { ComplaintStatus, CompensationStatus, IncidentStatus, SafeBoxStatus, Severity } from '@/domain/relations'
import { shortDay } from '@/lib/dates'
import type { Tone } from '../../ui/Badge'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

export const SEVERITY_TONE: Record<Severity, Tone> = { low: 'neutral', medium: 'warning', high: 'accent' }
export const COMPLAINT_TONE: Record<ComplaintStatus, Tone> = { open: 'accent', in_progress: 'info', resolved: 'success', closed: 'neutral' }
export const COMPENSATION_TONE: Record<CompensationStatus, Tone> = { pending_approval: 'warning', posted: 'success', rejected: 'neutral', given: 'success' }
export const INCIDENT_TONE: Record<IncidentStatus, Tone> = { open: 'accent', follow_up: 'info', closed: 'neutral' }
export const BOX_TONE: Record<SafeBoxStatus, Tone> = { free: 'success', in_use: 'info', out_of_order: 'neutral' }

/** "12 Nov, 08:10" from a `YYYY-MM-DDTHH:MM[:SS]` stamp. */
export const when = (at: string) => `${shortDay(at.slice(0, 10))}, ${at.slice(11, 16)}`

/** The device's local time as `YYYY-MM-DDTHH:MM` on the console's today, for a form's default. */
export const nowOn = (today: string) => {
  const d = new Date()
  return `${today}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** One busy key, field errors and a toast per mutation: success reloads, a failure keeps the input. */
export function useRun(reload: () => void) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  async function run(key: string, title: string, action: () => Promise<unknown>) {
    setBusy(key)
    setErrors({})
    try {
      await action()
      toast({ title })
      reload()
      return true
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Not saved', description: Object.values(e)[0] })
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, errors, run }
}
