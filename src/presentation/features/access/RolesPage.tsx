import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { RotateCcw, Save } from 'lucide-react'
import { ACTION_LABEL, ACTIONS, actionsFor, DEFAULT_PERMISSIONS, MODULE_LABEL, MODULES, ROLE_LABEL, ROLES, type Action, type Module, type Permissions, type Role } from '@/domain/access'
import { cn } from '@/lib/cn'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'

type RolePerms = Permissions[Role]

const toggle = (perms: RolePerms, module: Module, action: Action): RolePerms => {
  const current = perms[module]
  const next = current.includes(action) ? current.filter((a) => a !== action) : [...ACTIONS.filter((a) => a === action || current.includes(a))]
  // Nothing without view: dropping view clears the row, adding any action adds view.
  const withView = action === 'view' && !next.includes('view') ? [] : next.includes('view') || next.length === 0 ? next : ['view' as Action, ...next]
  return { ...perms, [module]: withView }
}

/** The permission matrix per role: modules down, actions across, saved one role at a time. */
export default function RolesPage() {
  const { access } = useServices()
  const { user, can } = useAccess()
  const toast = useToast()
  const data = useResource('access.permissions', () => access.permissions())
  const [params, setParams] = useSearchParams()
  const role = (ROLES.find((r) => r === params.get('role')) ?? 'manager') as Role
  const [draft, setDraft] = useState<{ role: Role; perms: RolePerms } | null>(null)
  const [saving, setSaving] = useState(false)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const all = data.data
  const saved = all[role]
  const perms = draft?.role === role ? draft.perms : saved
  const locked = !can('access', 'edit') || (role === 'owner' && user.role !== 'owner')
  const dirty = draft?.role === role && JSON.stringify(draft.perms) !== JSON.stringify(saved)

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      data.setData(await access.savePermissions(draft.role, draft.perms))
      setDraft(null)
      toast({ title: `Saved ${ROLE_LABEL[draft.role]} permissions`, description: 'Everyone with the role sees the change on their next page.' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save', description: error instanceof Error ? error.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">What each role may do per module. View opens the pages; submit, approve and post are the money steps; report unlocks the Reports section.</p>
        <Select aria-label="Role" tone="card" value={role} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} onChange={(e) => setParams({ role: e.target.value }, { replace: true })} />
      </div>
      <ul className="grid grid-cols-2 gap-3 stagger sm:grid-cols-4" aria-label="Granted actions per role">
        {ROLES.map((r) => {
          const granted = MODULES.reduce((n, m) => n + all[r][m].length, 0)
          const total = MODULES.reduce((n, m) => n + actionsFor(m).length, 0)
          return (
            <li key={r}>
              <button
                type="button"
                aria-pressed={r === role}
                onClick={() => setParams({ role: r }, { replace: true })}
                className={cn('block w-full min-w-0 cursor-pointer rounded-card border p-4 text-left shadow-card transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-float', r === role ? 'border-fg bg-raised' : 'border-line bg-card')}
              >
                <span className="block truncate text-xs text-muted">{ROLE_LABEL[r]}</span>
                <span className="mt-1 block text-xl font-medium tracking-tight tabular">{granted}</span>
                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-control">
                  <span className="block h-full origin-left animate-grow rounded-full bg-fg" style={{ width: `${Math.round((granted / total) * 100)}%` }} />
                </span>
                <span className="mt-1 block text-[11px] text-muted">{Math.round((granted / total) * 100)}% of actions</span>
              </button>
            </li>
          )
        })}
      </ul>
      <Card className="p-0" aria-labelledby="matrix-title">
        <div className="p-5 pb-0">
          <CardHeader
            id="matrix-title"
            title={`${ROLE_LABEL[role]} permissions`}
            action={
              <>
                {dirty && (
                  <Button variant="soft" size="sm" onClick={() => setDraft(null)}>
                    <RotateCcw aria-hidden className="size-3.5" /> Discard
                  </Button>
                )}
                {!locked && (
                  <Button variant="soft" size="sm" onClick={() => setDraft({ role, perms: structuredClone(DEFAULT_PERMISSIONS[role]) })}>
                    Reset to default
                  </Button>
                )}
                <Button variant="accent" size="sm" loading={saving} disabled={!dirty || locked} onClick={() => void save()}>
                  <Save aria-hidden className="size-3.5" /> Save
                </Button>
              </>
            }
          />
          {locked && <p className="mb-3 text-xs text-muted">{role === 'owner' ? 'Only the owner changes the owner’s permissions.' : 'Your role can view this matrix but not change it.'}</p>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={`${ROLE_LABEL[role]} permission matrix`}>
            <thead>
              <tr className="text-left text-xs tracking-wide text-muted uppercase">
                <th scope="col" className="py-2 pr-3 pl-5 font-medium">
                  Module
                </th>
                {ACTIONS.map((a) => (
                  <th key={a} scope="col" className="px-3 py-2 text-center font-medium">
                    {ACTION_LABEL[a]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line stagger">
              {MODULES.map((m) => (
                <tr key={m} className={cn(perms[m].length === 0 && 'text-muted')}>
                  <th scope="row" className="py-2.5 pr-3 pl-5 text-left font-medium whitespace-nowrap">
                    {MODULE_LABEL[m]}
                  </th>
                  {ACTIONS.map((a) => (
                    <td key={a} className="px-3 py-2.5 text-center">
                      {actionsFor(m).includes(a) ? (
                        <Switch label={`${ROLE_LABEL[role]} can ${ACTION_LABEL[a].toLowerCase()} ${MODULE_LABEL[m]}`} checked={perms[m].includes(a)} disabled={locked} onChange={() => setDraft({ role, perms: toggle(perms, m, a) })} />
                      ) : (
                        <span aria-hidden className="text-subtle">·</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-muted">Owner and administrator sign any approval level; everyone else signs only the level that names their role. The author of an entry never approves it.</p>
      </Card>
    </div>
  )
}
