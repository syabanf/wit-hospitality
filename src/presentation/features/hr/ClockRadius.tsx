import { useState, type FormEvent } from 'react'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

/** The distance from the villa within which a self clock reads "At the villa". Only HR with edit changes it. */
export function ClockRadius({ editable }: { editable: boolean }) {
  const { selfService } = useServices()
  const toast = useToast()
  const data = useResource('selfService.attendanceSettings', () => selfService.attendanceSettings())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  if (!data.data) return null
  const radius = data.data.radiusMeters

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const saved = await selfService.saveAttendanceSettings({ radiusMeters: Number(new FormData(e.currentTarget).get('radius')) })
      toast({ title: 'Clock-in radius saved', description: `${saved.radiusMeters} m from the villa counts as at the villa` })
      data.reload()
    } catch (err) {
      const errors = fieldErrors(err)
      setError(errors.radiusMeters ?? errors.form ?? 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  if (!editable) return <p className="text-xs text-muted">A self clock within {radius} m of the villa reads as at the villa.</p>
  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <label htmlFor="clock-radius">At the villa within</label>
      <Input key={radius} id="clock-radius" name="radius" type="number" inputMode="numeric" min={20} max={5000} step={10} defaultValue={radius} className="w-24 tabular" aria-describedby={error ? 'clock-radius-error' : undefined} />
      <span>m</span>
      <Button type="submit" size="sm" variant="soft" loading={saving}>
        Save
      </Button>
      {error && (
        <span id="clock-radius-error" role="alert" className="font-medium text-danger">
          {error}
        </span>
      )}
    </form>
  )
}
