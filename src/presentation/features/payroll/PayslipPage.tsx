import { useParams } from 'react-router'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Gate } from '../../ui/Gate'
import { PageBar } from '../../ui/PageBar'
import { PayslipSheet } from '../shared/PayslipSheet'

export default function PayslipPage() {
  const { id = '', employeeId = '' } = useParams()
  const { payroll } = useServices()
  const resource = useResource(`payroll.payslip:${id}:${employeeId}`, () => payroll.payslip(id, employeeId), { keepPrevious: false })
  return (
    <Gate resource={resource} what="payslip" back={{ to: `/payroll/${id}`, label: 'Back to the period' }}>
      {(d) => (
        <>
          <div className="print:hidden">
            <PageBar fallback={`/payroll/${id}`} label={d.label} />
          </div>
          <PayslipSheet period={d.period} label={d.label} line={d.line} employee={d.employee} catalog={d.catalog} />
        </>
      )}
    </Gate>
  )
}
