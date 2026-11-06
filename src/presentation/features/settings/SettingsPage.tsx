import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { KeyRound, RotateCcw, UserRoundCog } from 'lucide-react'
import { ROLE_LABEL, type Profile } from '@/domain/account'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { useTheme } from '../../hooks/useTheme'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'
import { LostFoundSettingsCard } from './LostFoundSettingsCard'

const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const

const EMPTY_PASSWORD = { current: '', next: '', confirm: '' }

function PasswordCard() {
  const { access } = useServices()
  const toast = useToast()
  const [form, setForm] = useState(EMPTY_PASSWORD)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      await access.changePassword(form)
      setForm(EMPTY_PASSWORD)
      toast({ title: 'Password changed', description: 'Use the new one next time you sign in.' })
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card aria-labelledby="password-title">
      <CardHeader id="password-title" title="Password" />
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="Current password" htmlFor="pw-current" error={errors.current ?? errors.form}>
          <Input id="pw-current" type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="New password" htmlFor="pw-next" error={errors.next} hint="At least 8 characters">
            <Input id="pw-next" type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
          </Field>
          <Field label="Repeat it" htmlFor="pw-confirm" error={errors.confirm}>
            <Input id="pw-confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </Field>
        </div>
        <Button type="submit" variant="solid" loading={saving} disabled={!form.current || !form.next}>
          <KeyRound aria-hidden className="size-4" /> Change password
        </Button>
      </form>
    </Card>
  )
}

export default function SettingsPage() {
  const { account, dashboard } = useServices()
  const { reload } = useAccess()
  const toast = useToast()
  const [theme, setTheme] = useTheme()
  const profile = useResource('account.profile', () => account.profile())
  const options = useResource('dashboard.filterOptions', () => dashboard.filterOptions())
  const [draft, setDraft] = useState<Profile | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (profile.status === 'error' && !profile.data) return <ErrorState error={profile.error} onRetry={profile.reload} />
  if (!profile.data) return <CardSkeleton lines={5} />
  const p = draft ?? profile.data
  const catalog = options.data?.catalog
  const scope = p.villaIds.length
    ? p.villaIds.map((id) => catalog?.villas.find((v) => v.id === id)?.name ?? id).join(', ')
    : p.locationIds.length
      ? p.locationIds.map((id) => catalog?.locations.find((l) => l.id === id)?.name ?? id).join(', ')
      : 'every location'

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      profile.setData(await account.saveProfile(p))
      setDraft(null)
      reload()
      toast({ title: 'Settings saved' })
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <form onSubmit={(e) => void save(e)} className="space-y-4">
        <Card aria-labelledby="profile-title">
          <CardHeader id="profile-title" title="Profile" />
          <div className="space-y-4">
            <Field label="Name" htmlFor="name" error={errors.name}>
              <Input id="name" value={p.name} onChange={(e) => setDraft({ ...p, name: e.target.value })} />
            </Field>
            <Field label="Email" htmlFor="email" error={errors.email}>
              <Input id="email" type="email" value={p.email} onChange={(e) => setDraft({ ...p, email: e.target.value })} />
            </Field>
            <Field label="Role" hint="Roles and villa access are managed by the administrator under Access.">
              <p className="flex min-h-12 items-center rounded-full border border-dashed border-line-strong px-4 text-sm text-muted">
                {ROLE_LABEL[p.role]} · {scope}
              </p>
            </Field>
          </div>
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
                <span className="block text-xs text-muted">When an entry waits for your signature.</span>
              </span>
              <Switch label="Notify about approvals" checked={p.notifyApprovals} onChange={(on) => setDraft({ ...p, notifyApprovals: on })} />
            </li>
          </ul>
        </Card>
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving} disabled={!draft}>
            Save settings
          </Button>
          <Button variant="soft" disabled={!draft} onClick={() => setDraft(null)}>
            Reset
          </Button>
        </div>
      </form>
      <div className="space-y-4">
        <Card aria-labelledby="look-title">
          <CardHeader id="look-title" title="Appearance" />
          <Tabs label="Theme" options={THEMES} value={theme} onChange={setTheme} />
        </Card>
        <PasswordCard />
        <LostFoundSettingsCard />
        <Card aria-labelledby="switch-title">
          <CardHeader id="switch-title" title="Switch login" />
          <p className="text-sm text-body">The demo lists one login per role on the sign-in page, so a reviewer can see the console as the owner, finance, HR, a villa manager or front-desk staff.</p>
          <Link to="/login" className={buttonStyles({ variant: 'soft', className: 'mt-4' })}>
            <UserRoundCog aria-hidden className="size-4" /> Open the sign-in page
          </Link>
        </Card>
        <Card aria-labelledby="demo-title">
          <CardHeader id="demo-title" title="Demo data" />
          <p className="text-sm text-body">Bookings, requests, cash entries, HR records and logins you change today stay in this browser until midnight. Reset to start the demo again from the seed.</p>
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
      </div>
    </div>
  )
}
