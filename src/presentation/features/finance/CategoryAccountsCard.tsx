import { KIND_LABEL } from '@/domain/finance'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { CardSkeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'

/** Which ledger account each category books to; a change applies to entries posted from now on. */
export function CategoryAccountsCard() {
  const { accounting } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('accounting.categoryAccounts', () => accounting.categoryAccounts())
  const editable = can('finance', 'edit')

  async function map(categoryId: string, name: string, accountId: string) {
    try {
      await accounting.mapCategory(categoryId, accountId)
      toast({ title: `${name} remapped`, description: 'Entries posted from now on book to the new account; posted journals stay as they are.' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not remap ${name}`, description: error instanceof Error ? error.message : undefined })
    }
  }

  if (!data.data) return data.status === 'error' ? null : <CardSkeleton lines={4} />
  const options = data.data.accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))

  return (
    <Card aria-labelledby="cat-gl">
      <CardHeader id="cat-gl" title="Ledger accounts" />
      <p className="mb-4 max-w-2xl text-sm text-muted">Each posted entry debits or credits its cash account against the account its category books to here. Transfers and payroll book on their own.</p>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
        {data.data.categories.map((c) => (
          <li key={c.id} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm">
              {c.name} <span className="text-xs text-muted">{KIND_LABEL[c.kind]}</span>
            </span>
            <Select compact aria-label={`Ledger account for ${c.name}`} className="w-56" value={c.accountId} disabled={!editable} options={options} onChange={(e) => void map(c.id, c.name, e.target.value)} />
          </li>
        ))}
      </ul>
    </Card>
  )
}
