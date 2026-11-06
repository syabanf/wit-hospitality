import { useState } from 'react'
import { Building } from 'lucide-react'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Popover } from '../../ui/Popover'
import { useToast } from '../../ui/useToast'

/** Moves a master-billed group's room nights, every stay's share, to a city ledger account. */
export function GroupTransfer({ groupId, accountId, due, onDone }: { groupId: string; accountId: string | null; due: number; onDone: () => void }) {
  const { cityLedger } = useServices()
  const toast = useToast()
  const options = useResource('cityLedger.bookingOptions', () => cityLedger.bookingOptions())
  const [picked, setPicked] = useState('')
  const [saving, setSaving] = useState(false)
  const accounts = options.data?.accounts ?? []
  if (accounts.length === 0) return null
  const account = picked || accountId || accounts[0]?.id || ''

  async function transfer(close: () => void) {
    setSaving(true)
    try {
      const posted = await cityLedger.transferGroup(groupId, account)
      toast({ title: `Moved ${money(posted.reduce((s, p) => s + p.amount, 0))} to the city ledger` })
      close()
      onDone()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not transfer the master folio', description: Object.values(fieldErrors(error))[0] })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover align="right" className="w-80 animate-pop-in p-4" trigger={(props) => (
      <Button {...props} size="sm" variant="soft">
        <Building aria-hidden className="size-3.5" /> City ledger
      </Button>
    )}>
      {(close) => (
        <div className="space-y-3">
          <p className="text-sm font-semibold">Transfer the master folio</p>
          <Field label="Bill to" htmlFor={`gt-${groupId}`} hint="Every stay’s room nights move; extras stay with each stay">
            <Select id={`gt-${groupId}`} className="w-full" value={account} options={accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} onChange={(e) => setPicked(e.target.value)} />
          </Field>
          <Button variant="accent" size="sm" loading={saving} onClick={() => void transfer(close)}>
            Transfer {money(due)}
          </Button>
        </div>
      )}
    </Popover>
  )
}
