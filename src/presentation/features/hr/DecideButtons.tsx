import { useState, type FormEvent } from 'react'
import { Check, X } from 'lucide-react'
import type { Decide } from '@/application/ports'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Popover } from '../../ui/Popover'
import { useToast } from '../../ui/useToast'

interface DecideButtonsProps {
  /** The request number, for the toast. */
  number: string
  decide: (to: Decide, note: string) => Promise<unknown>
  onDone: () => void
  /** Only Cancel, for the person who made the request. */
  own?: boolean
  size?: 'sm' | 'md'
  /** Icon-only buttons for a table cell. */
  compact?: boolean
}

/** Approve in one click, Reject with a required note, or Cancel; the service writes who decided. */
export function DecideButtons({ number, decide, onDone, own = false, size = 'sm', compact = false }: DecideButtonsProps) {
  const toast = useToast()
  const [busy, setBusy] = useState<Decide | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(to: Decide, note = '') {
    setBusy(to)
    setErrors({})
    try {
      await decide(to, note)
      toast({ title: `${to === 'approved' ? 'Approved' : to === 'rejected' ? 'Rejected' : 'Cancelled'} ${number}` })
      onDone()
      return true
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: `Could not update ${number}`, description: Object.values(e)[0] })
      return false
    } finally {
      setBusy(null)
    }
  }

  if (own) {
    return (
      <Button size={size} variant="soft" loading={busy === 'cancelled'} onClick={() => void run('cancelled')}>
        Cancel request
      </Button>
    )
  }

  return (
    <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <Button size={compact ? 'icon-sm' : size} variant="solid" aria-label={compact ? `Approve ${number}` : undefined} title={compact ? 'Approve' : undefined} loading={busy === 'approved'} onClick={() => void run('approved')}>
        {busy !== 'approved' && <Check aria-hidden className="size-3.5" />}
        {!compact && 'Approve'}
      </Button>
      <Popover
        align="right"
        className="w-72 p-4"
        trigger={(props) => (
          <Button {...props} size={compact ? 'icon-sm' : size} variant="soft" aria-label={compact ? `Reject ${number}` : undefined} title={compact ? 'Reject' : undefined}>
            <X aria-hidden className="size-3.5" />
            {!compact && 'Reject'}
          </Button>
        )}
      >
        {(close) => (
          <form
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault()
              void run('rejected', String(new FormData(e.currentTarget).get('note') ?? '')).then((ok) => ok && close())
            }}
            className="space-y-3"
          >
            <Field label="Why" htmlFor={`reject-${number}`} error={errors.note ?? errors.form}>
              <Input id={`reject-${number}`} name="note" placeholder="The reason stays on the request" />
            </Field>
            <Button type="submit" size="sm" variant="accent" loading={busy === 'rejected'}>
              Reject {number}
            </Button>
          </form>
        )}
      </Popover>
    </span>
  )
}
