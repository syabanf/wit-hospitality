import { useState, type FormEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import { ROLE_LABEL, type Profile } from '@/domain/account'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { useTheme } from '../../hooks/useTheme'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'

const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const

export default function SettingsPage() {
  const { account } = useServices()
  const toast = useToast()
  const [theme, setTheme] = useTheme()
  const profile = useResource('account.profile', () => account.profile())
  const [draft, setDraft] = useState<Profile | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (profile.status === 'error' && !profile.data) return <ErrorState error={profile.error} onRetry={profile.reload} />
  if (!profile.data) return <CardSkeleton lines={5} />
  const p = draft ?? profile.data

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      profile.setData(await account.saveProfile(p))
      setDraft(null)
      toast({ title: 'Settings saved' })
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card aria-labelledby="profile-title">
        <CardHeader id="profile-title" title="Profile" />
        <div className="space-y-4">
          <Field label="Name" htmlFor="name" error={errors.name}>
            <Input id="name" value={p.name} onChange={(e) => setDraft({ ...p, name: e.target.value })} />
          </Field>
          <Field label="Email" htmlFor="email" error={errors.email}>
            <Input id="email" type="email" value={p.email} onChange={(e) => setDraft({ ...p, email: e.target.value })} />
          </Field>
          <Field label="Role" hint="Roles and villa access are managed by the administrator.">
            <p className="flex h-12 items-center rounded-full border border-dashed border-line-strong px-4 text-sm text-muted">{ROLE_LABEL[p.role]} · every location</p>
          </Field>
        </div>
      </Card>
      <div className="space-y-4">
        <Card aria-labelledby="look-title">
          <CardHeader id="look-title" title="Appearance" />
          <Tabs label="Theme" options={THEMES} value={theme} onChange={setTheme} />
        </Card>
        <Card aria-labelledby="notify-title">
          <CardHeader id="notify-title" title="Notifications" />
          <ul className="divide-y divide-line">
            <li className="flex items-center gap-4 py-3 first:pt-0">
              <span className="flex-1">
                <span className="block text-sm font-medium">Arrivals and departures</span>
                <span className="block text-xs text-muted">A morning summary of who comes and goes.</span>
              </span>
              <Switch label="Notify about arrivals" checked={p.notifyArrivals} onChange={(on) => setDraft({ ...p, notifyArrivals: on })} />
            </li>
            <li className="flex items-center gap-4 py-3 last:pb-0">
              <span className="flex-1">
                <span className="block text-sm font-medium">Approvals</span>
                <span className="block text-xs text-muted">When an entry waits for your approval.</span>
              </span>
              <Switch label="Notify about approvals" checked={p.notifyApprovals} onChange={(on) => setDraft({ ...p, notifyApprovals: on })} />
            </li>
          </ul>
        </Card>
        <Card aria-labelledby="demo-title">
          <CardHeader id="demo-title" title="Demo data" />
          <p className="text-sm text-body">Bookings, requests and cash entries you add today stay in this browser until midnight. Reset to start the demo again from the seed.</p>
          <Button
            variant="soft"
            className="mt-4"
            onClick={() => {
              try {
                localStorage.removeItem('wit-demo-state')
              } catch {
                // Storage blocked: the reload rebuilds the seed anyway.
              }
              toast({ title: 'Demo data reset', description: 'Reloading with the seed.' })
              setTimeout(() => location.reload(), 600)
            }}
          >
            <RotateCcw aria-hidden className="size-4" /> Reset demo data
          </Button>
        </Card>
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving} disabled={!draft}>
            Save settings
          </Button>
          <Button variant="soft" disabled={!draft} onClick={() => setDraft(null)}>
            Reset
          </Button>
        </div>
      </div>
    </form>
  )
}
