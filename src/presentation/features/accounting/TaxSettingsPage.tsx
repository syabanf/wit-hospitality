import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Landmark } from 'lucide-react'
import { PRICE_MODE_LABEL, type PriceMode } from '@/domain/tax'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'

type Data = Awaited<ReturnType<ReturnType<typeof useServices>['accounting']['taxSettings']>>

/** The rates form: a new set of rates applies from its date on, earlier postings keep theirs. */
function RatesForm({ d, onSaved }: { d: Data; onSaved: () => void }) {
  const { accounting } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const current = d.current
  const [service, setService] = useState<string[]>([...(current?.serviceCodes ?? [])])
  const [pb1, setPb1] = useState<string[]>([...(current?.pb1Codes ?? [])])
  const [onService, setOnService] = useState(current?.pb1OnService ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const editable = can('finance', 'edit')
  const toggle = (list: string[], code: string, on: boolean) => (on ? [...list, code] : list.filter((c) => c !== code))

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await accounting.saveTaxSettings({
        rates: { effectiveFrom: String(f.get('effectiveFrom') ?? ''), servicePct: Number(f.get('servicePct')), pb1Pct: Number(f.get('pb1Pct')), pb1OnService: onService, serviceCodes: service, pb1Codes: pb1 },
        directMode: f.get('directMode') as PriceMode,
        regencies: Object.fromEntries(d.locations.map((l) => [l.id, String(f.get(`regency-${l.id}`) ?? '')])),
      })
      toast({ title: 'Tax settings saved', description: 'Postings from the effective date on use them.' })
      onSaved()
    } catch (error) {
      setErrors(fieldErrors(error))
      toast({ tone: 'danger', title: 'Could not save the tax settings', description: error instanceof Error ? error.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4">
      <div className="stagger grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card aria-labelledby="tax-rates">
          <CardHeader id="tax-rates" title="Rates" />
          <div className="space-y-4">
            <Field label="Effective from" htmlFor="tax-from" hint="Today or later; postings before it keep the rates they were made at" error={errors.effectiveFrom}>
              <Input id="tax-from" name="effectiveFrom" type="date" min={d.today} defaultValue={d.today} disabled={!editable} />
            </Field>
            <Field label="Service charge, %" htmlFor="tax-service" error={errors.servicePct}>
              <Input id="tax-service" name="servicePct" type="number" step={0.5} min={0} defaultValue={current?.servicePct ?? 0} disabled={!editable} className="tabular" />
            </Field>
            <Field label="PB1, %" htmlFor="tax-pb1" hint="Pajak Hotel, paid to the regency" error={errors.pb1Pct}>
              <Input id="tax-pb1" name="pb1Pct" type="number" step={0.5} min={0} defaultValue={current?.pb1Pct ?? 0} disabled={!editable} className="tabular" />
            </Field>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>PB1 on the amount plus service (++)</span>
              <Switch checked={onService} onChange={setOnService} label="PB1 on the amount plus service" disabled={!editable} />
            </div>
          </div>
        </Card>
        <Card aria-labelledby="tax-codes">
          <CardHeader id="tax-codes" title="Codes that carry them" />
          {errors.codes && <p role="alert" className="mb-2 text-xs text-danger">{errors.codes}</p>}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-1 font-medium">Code</th>
                <th scope="col" className="py-1 text-center font-medium">Service</th>
                <th scope="col" className="py-1 text-center font-medium">PB1</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.codes.map((c) => (
                <tr key={c.id}>
                  <td className="py-1.5">
                    <span className="font-mono text-xs">{c.code}</span> <span className="text-muted">{c.name}</span>
                  </td>
                  <td className="py-1.5 text-center">
                    <input type="checkbox" aria-label={`${c.code} carries service`} checked={service.includes(c.code)} disabled={!editable} onChange={(e) => setService(toggle(service, c.code, e.target.checked))} />
                  </td>
                  <td className="py-1.5 text-center">
                    <input type="checkbox" aria-label={`${c.code} carries PB1`} checked={pb1.includes(c.code)} disabled={!editable} onChange={(e) => setPb1(toggle(pb1, c.code, e.target.checked))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card aria-labelledby="tax-mode">
          <CardHeader id="tax-mode" title="Prices and regencies" />
          <div className="space-y-4">
            <Field label="Direct prices and rate plans" htmlFor="tax-direct" hint="New direct stays sell this way. Airbnb prices are always inclusive: Airbnb collects, the operator remits.">
              <Select id="tax-direct" name="directMode" className="w-full" defaultValue={d.tax.directMode} disabled={!editable} options={(['net', 'inclusive'] as const).map((m) => ({ value: m, label: PRICE_MODE_LABEL[m] }))} />
            </Field>
            {d.locations.map((l) => (
              <Field key={l.id} label={`${l.name} pays PB1 to`} htmlFor={`regency-${l.id}`} error={errors.regencies}>
                <Input id={`regency-${l.id}`} name={`regency-${l.id}`} defaultValue={l.regency} disabled={!editable} />
              </Field>
            ))}
          </div>
        </Card>
      </div>
      {editable && (
        <Button type="submit" variant="accent" loading={saving}>
          Save tax settings
        </Button>
      )}
    </form>
  )
}

/** Service charge and PB1: rates by effective date, the codes that carry them, price mode, regencies, and Pay PB1 per closed month. */
export default function TaxSettingsPage() {
  const { accounting } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('accounting.taxSettings', () => accounting.taxSettings())
  const [busy, setBusy] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  async function pay(e: FormEvent<HTMLFormElement>, month: string, label: string) {
    e.preventDefault()
    setBusy(month)
    try {
      const created = await accounting.payPb1(month, String(new FormData(e.currentTarget).get('account') ?? ''))
      toast({ title: `Submitted ${created.length} PB1 ${created.length === 1 ? 'remittance' : 'remittances'} for ${label}`, description: 'Waiting for approval like any cash-out.' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not pay PB1', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        Every taxable folio line carries its service charge on SVC and PB1 on PB1. A net price adds them on the bill; an inclusive price holds them and the folio splits it. The books credit Service charge payable (2400), which payroll shares out, and PB1 payable (2330), which finance pays to the regency each month.
      </p>
      <RatesForm key={version} d={d} onSaved={() => {
        setVersion((v) => v + 1)
        data.reload()
      }} />
      <Card aria-labelledby="tax-history">
        <CardHeader id="tax-history" title="Rate history" />
        <ul className="divide-y divide-line text-sm">
          {[...d.tax.rates].reverse().map((r) => (
            <li key={r.effectiveFrom} className="flex flex-wrap justify-between gap-2 py-2">
              <span>From {r.effectiveFrom}</span>
              <span className="text-muted">
                Service {r.servicePct}% on {r.serviceCodes.join(', ') || 'no code'} · PB1 {r.pb1Pct}%{r.pb1OnService ? ' on the amount plus service' : ''} on {r.pb1Codes.join(', ') || 'no code'}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card aria-labelledby="tax-pb1">
        <CardHeader id="tax-pb1" title="PB1 remittance" action={<Link to="/reports/pb1-regency" className="text-sm text-muted hover:underline">PB1 by regency</Link>} />
        {d.months.length === 0 && <p className="text-sm text-muted">Close a month on the Period close page to pay its PB1.</p>}
        <ul className="divide-y divide-line">
          {d.months.map((m) => {
            const unpaid = m.remittances.filter((r) => r.amount > 0 && !r.entry)
            return (
              <li key={m.month} className="space-y-2 py-3 first:pt-0 last:pb-0">
                <p className="font-medium">{m.label}</p>
                <ul className="text-sm">
                  {m.remittances.map((r) => (
                    <li key={r.regency} className="flex flex-wrap items-center justify-between gap-2 py-1">
                      <span>{r.regency}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular">{money(r.amount)}</span>
                        {r.entry ? (
                          <Link to={`/finance/transactions/${r.entry.id}`}>
                            <StatusPill tone={r.entry.status === 'posted' ? 'success' : 'warning'}>{`${r.entry.number} ${TRANSACTION_STATUS_LABEL[r.entry.status]}`}</StatusPill>
                          </Link>
                        ) : r.amount > 0 ? (
                          <StatusPill tone="danger">Not paid</StatusPill>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {can('finance', 'post') && unpaid.length > 0 && (
                  <form onSubmit={(e) => void pay(e, m.month, m.label)} className="flex flex-wrap items-center gap-2">
                    <Select aria-label={`Pay ${m.label} PB1 from`} name="account" options={d.accounts.map((a) => ({ value: a.id, label: a.name }))} />
                    <Button type="submit" size="sm" variant="accent" loading={busy === m.month}>
                      <Landmark aria-hidden className="size-4" /> Pay PB1
                    </Button>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}
