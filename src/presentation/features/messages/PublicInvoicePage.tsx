import { useParams } from 'react-router'
import { Printer } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { CardSkeleton, EmptyState } from '../../ui/States'
import { InvoiceSheet } from '../payments/InvoicePage'

/** The e-invoice the thank-you message links to. No sign-in: the signed token is the key. */
export default function PublicInvoicePage() {
  const { token = '' } = useParams()
  const { messaging } = useServices()
  const data = useResource(`messaging.invoice:${token}`, () => messaging.invoice(token), { keepPrevious: false })
  return (
    <div className="min-h-dvh bg-canvas px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-3xl justify-end print:hidden">
        <Button variant="accent" disabled={!data.data} onClick={() => window.print()}>
          <Printer aria-hidden className="size-4" /> Print or save as PDF
        </Button>
      </div>
      {data.data ? (
        <InvoiceSheet inv={data.data} />
      ) : data.status === 'error' ? (
        <div className="mx-auto max-w-md">
          <EmptyState title="This invoice link does not work">Ask your host to send it again.</EmptyState>
        </div>
      ) : (
        <CardSkeleton className="mx-auto max-w-3xl" lines={8} />
      )}
    </div>
  )
}
