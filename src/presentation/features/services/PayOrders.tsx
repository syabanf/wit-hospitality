import { useState } from 'react'
import { Wallet } from 'lucide-react'
import type { Attachment } from '@/domain/attachment'
import { isGateway, PAYMENT_METHOD_LABEL, type PaymentMethod } from '@/domain/payment'
import { money } from '@/lib/format'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'
import { AttachmentPicker } from '../shared/Attachments'

const METHODS: readonly PaymentMethod[] = ['cash', 'bank_transfer', 'qris', 'virtual_account', 'card']

/**
 * Takes the money for delivered orders. Cash and transfer are recorded at once; QRIS, VA and card
 * open a link the parent then shows as pending. Either way the cash-in goes to Finance for approval.
 */
export function PayOrders({ bookingId, orderIds, amount, onDone, id = 'pay-orders' }: { bookingId: string; orderIds: readonly string[]; amount: number; onDone: () => void; id?: string }) {
  const { orders } = useServices()
  const toast = useToast()
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [files, setFiles] = useState<readonly Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function pay() {
    setBusy(true)
    setErrors({})
    try {
      const result = await orders.pay({ bookingId, orderIds, method, reference, attachments: files })
      if (result.link) toast({ title: `${PAYMENT_METHOD_LABEL[method]} link ready`, description: 'Send it to the guest; the bill settles when they pay.' })
      else {
        toast({ title: `Took ${money(amount)} by ${PAYMENT_METHOD_LABEL[method].toLowerCase()}`, description: 'The cash-in waits for approval in Finance.' })
        setReference('')
        setFiles([])
      }
      onDone()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not take the payment', description: Object.values(e)[0] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Method" htmlFor={`${id}-method`}>
        <Select id={`${id}-method`} value={method} options={METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} onChange={(e) => setMethod(e.target.value as PaymentMethod)} />
      </Field>
      {method === 'bank_transfer' && (
        <Field label="Bank reference" htmlFor={`${id}-ref`} error={errors.reference}>
          <Input id={`${id}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="From the transfer slip" />
        </Field>
      )}
      {!isGateway(method) && (
        <Field label="Receipt" htmlFor={`${id}-files`} hint="Optional: a photo of the slip or the signed bill">
          <AttachmentPicker id={`${id}-files`} value={files} onChange={setFiles} />
        </Field>
      )}
      <Button variant="accent" className="w-full" loading={busy} disabled={orderIds.length === 0} onClick={() => void pay()}>
        <Wallet aria-hidden className="size-4" /> {isGateway(method) ? `Send a link for ${money(amount)}` : `Take ${money(amount)}`}
      </Button>
      {errors.form && (
        <p role="alert" className="text-xs font-medium text-danger">
          {errors.form}
        </p>
      )}
    </div>
  )
}
