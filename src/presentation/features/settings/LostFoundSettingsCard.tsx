import { useState, type FormEvent } from 'react'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

/** The lost and found holding period; someone who may approve in the guest module changes it. */
export function LostFoundSettingsCard() {
  const { lostFound } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const settings = useResource('lostFound.settings', () => lostFound.settings())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  if (!can('guest', 'view') || !settings.data) return null
  const editable = can('guest', 'approve')

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const saved = await lostFound.saveSettings({ holdDays: Number(new FormData(e.currentTarget).get('holdDays')) })
      toast({ title: `Found items are held ${saved.holdDays} days` })
      settings.reload()
    } catch (err) {
      setError(fieldErrors(err).form ?? 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card aria-labelledby="lf-title">
      <CardHeader id="lf-title" title="Lost and found" />
      <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-3">
        <Field label="Holding period, days" htmlFor="lf-hold" error={error} hint="Unclaimed items wait this long before they may be disposed of or donated">
          <Input id="lf-hold" name="holdDays" type="number" inputMode="numeric" min={7} max={365} defaultValue={settings.data.holdDays} disabled={!editable} className="w-32 tabular" />
        </Field>
        {editable && (
          <Button type="submit" variant="solid" loading={saving}>
            Save
          </Button>
        )}
      </form>
    </Card>
  )
}
