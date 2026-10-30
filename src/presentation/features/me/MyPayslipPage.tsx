import { useParams } from 'react-router'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Gate } from '../../ui/Gate'
import { PageBar } from '../../ui/PageBar'
import { PayslipSheet } from '../shared/PayslipSheet'

export default function MyPayslipPage() {
  const { id = '' } = useParams()
  const { people } = useServices()
  const resource = useResource(`people.payslip:${id}`, () => people.payslip(id), { keepPrevious: false })
  return (
    <Gate resource={resource} what="payslip" back={{ to: '/me/payslips', label: 'Back to payslips' }}>
      {(d) => (
        <>
          <div className="print:hidden">
            <PageBar fallback="/me/payslips" label="Payslips" />
          </div>
          <PayslipSheet period={d.period} label={d.label} line={d.line} employee={d.employee} catalog={d.catalog} />
        </>
      )}
    </Gate>
  )
}
