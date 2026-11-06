import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { ArrowRight, Eye, EyeOff, KeyRound } from 'lucide-react'
import { ROLE_LABEL, type Role } from '@/domain/access'
import { cn } from '@/lib/cn'
import { useServices } from '../../hooks/useServices'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { POP } from '../../ui/pop'
import { ThemeToggle } from '../../ui/ThemeToggle'

/** Demo logins, one per role; every one uses the shared demo password. */
const DEMO_LOGINS: ReadonlyArray<{ email: string; name: string; role: Role; note: string }> = [
  { email: 'rama@balivillas.id', name: 'Rama Wijaya', role: 'owner', note: 'Sees and signs everything' },
  { email: 'kadek@balivillas.id', name: 'Kadek Ariani', role: 'manager', note: 'Villa manager, every location' },
  { email: 'ida@balivillas.id', name: 'Ida Bagus Rai', role: 'finance', note: 'Approves and posts money' },
  { email: 'nia@balivillas.id', name: 'Nia Kusuma', role: 'hr', note: 'Employees and payroll' },
  { email: 'putu@balivillas.id', name: 'Putu Eka Wijaya', role: 'manager', note: 'Ubud only' },
  { email: 'wayan@balivillas.id', name: 'Wayan Sudiarta', role: 'staff', note: 'Front desk, Villa Saka' },
  { email: 'admin@balivillas.id', name: 'System administrator', role: 'admin', note: 'Users, roles, audit' },
  { email: 'hendra@balivillas.id', name: 'Hendra Gunawan', role: 'investor', note: 'Owns Villa Karang and Villa Pandawa' },
  { email: 'sophie@balivillas.id', name: 'Sophie Laurent', role: 'investor', note: 'Owns Villa Lumbung' },
]

/** Sign in with an email and password; the demo lists its logins so a reviewer can switch roles. */
export default function LoginPage() {
  const { access } = useServices()
  const navigate = useNavigate()
  const { state } = useLocation() as { state?: { from?: string } }
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const next = params.get('next') ?? (state?.from && state.from !== '/login' ? state.from : '/')

  async function signIn(e?: FormEvent, pick?: { email: string }) {
    e?.preventDefault()
    setBusy(true)
    setErrors({})
    try {
      await access.login({ email: pick?.email ?? email, password: pick ? 'villa123' : password })
      navigate(next, { replace: true })
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setBusy(false)
    }
  }

  // Quick login for the demo and the QA run: /login?as=wayan&next=/me signs in as that seeded user.
  const quick = params.get('as')
  useEffect(() => {
    if (!quick) return
    const pick = DEMO_LOGINS.find((u) => u.email.startsWith(`${quick}@`))
    if (pick) void signIn(undefined, pick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quick])

  return (
    <div className="min-h-dvh bg-canvas">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 py-6 md:px-8">
        <header className="flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <BrandMark className="size-7 text-fg" />
            <span className="text-base font-bold tracking-tight">
              Villa Console<span className="text-accent">.</span>
            </span>
          </span>
          <ThemeToggle />
        </header>
        <main className="grid flex-1 content-center gap-6 py-10 md:grid-cols-[minmax(0,1fr)_380px] md:gap-10">
          <section aria-labelledby="login-title" className="order-2 rounded-card border border-line bg-card p-6 shadow-card md:order-1">
            <h1 id="login-title" className="text-2xl font-bold tracking-tight">
              Sign in<span className="text-accent">.</span>
            </h1>
            <p className="mt-1 text-sm text-muted">Bali Villa Console for 20 units in 4 locations.</p>
            <form onSubmit={(e) => void signIn(e)} className="mt-6 space-y-4">
              <Field label="Email" htmlFor="login-email" error={errors.email}>
                <Input id="login-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@balivillas.id" />
              </Field>
              <Field label="Password" htmlFor="login-password" error={errors.password ?? errors.form}>
                <Input
                  id="login-password"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  trailing={
                    <Button variant="ghost" size="icon-sm" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={() => setShow((v) => !v)}>
                      {show ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                    </Button>
                  }
                />
              </Field>
              <Button type="submit" variant="accent" loading={busy} className="w-full">
                <KeyRound aria-hidden className="size-4" /> Sign in
              </Button>
            </form>
            <p className="mt-4 text-xs text-muted">Forgot the password? The administrator resets it from Access › Users.</p>
          </section>
          <aside className={cn('order-1 rounded-card p-6 md:order-2', POP.ink)}>
            <p className="text-xs font-semibold tracking-wider uppercase opacity-70">Demo logins</p>
            <p className="mt-1 text-sm opacity-80">
              Every login uses the password <span className="font-mono font-semibold">villa123</span>. Pick one to see the console as that role.
            </p>
            <ul className="mt-4 space-y-1.5">
              {DEMO_LOGINS.map((u) => (
                <li key={u.email}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void signIn(undefined, u)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors hover:bg-white/10 disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{u.name}</span>
                      <span className="block truncate text-xs opacity-70">
                        {ROLE_LABEL[u.role]} · {u.note}
                      </span>
                    </span>
                    <ArrowRight aria-hidden className="size-4 shrink-0 opacity-70" />
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </main>
      </div>
    </div>
  )
}
