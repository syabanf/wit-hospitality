import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Download, Send } from 'lucide-react'
import type { ForeignRow } from '@/application/guests'
import { APOA_COLUMNS, countryName, ID_TYPE_LABEL } from '@/domain/guest'
import { shortDay } from '@/lib/dates'
import { csvFileName, toCsv } from '@/lib/csv'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function status(r: ForeignRow) {
  if (r.report) return <Tag tone="success">Reported</Tag>
  return r.overdue ? <Tag tone="danger">Overdue</Tag> : <Tag tone="warning">Not yet reported</Tag>
}

/** Foreign guests per day and villa for Immigration: who checked in or is in house, reported or not, and the APOA export. */
export default function ForeignGuestsPage() {
  const { guest, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const date = params.get('date') || clock.today()
  const villaId = params.get('villa') ?? ''
  const data = useResource(`guest.foreign:${date}:${villaId}`, () => guest.foreign({ date, villaId: villaId || undefined }))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [reference, setReference] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (key: 'date' | 'villa', value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
    setPicked(new Set())
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { rows, villas, apoa } = data.data
  const open = rows.filter((r) => !r.report)
  const ready = open.filter((r) => r.missing.length === 0)
  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  async function markReported() {
    const chosen = ready.filter((r) => picked.has(r.key))
    setSaving(true)
    setError('')
    try {
      for (const bookingId of new Set(chosen.map((r) => r.booking.id))) await guest.markReported(bookingId, chosen.filter((r) => r.booking.id === bookingId).map((r) => r.personId), reference)
      toast({ title: `Marked ${chosen.length} reported`, description: reference ? `APOA reference ${reference}` : undefined })
      setPicked(new Set())
      setReference('')
      data.reload()
    } catch (e) {
      setError(fieldErrors(e).form ?? 'Could not mark them reported.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">
        Foreign adults who checked in or stayed in house on the day. Immigration expects each one through APOA within 24 hours of check-in. Export the day, upload it on the APOA site, then mark the guests reported with the receipt number.
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Foreign guests" value={rows.length} />
        <StatTile label="Not yet reported" value={open.length} />
        <StatTile label="Overdue" value={open.filter((r) => r.overdue).length} hint="Past 24 hours" />
        <StatTile label="Missing data" value={open.filter((r) => r.missing.length > 0).length} hint="Fix before reporting" />
      </div>
      <Card className="p-0">
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-4">
          <Input type="date" aria-label="Day" value={date} onChange={(e) => set('date', e.target.value)} className="h-10 w-44" />
          <Select aria-label="Villa" value={villaId} onChange={(e) => set('villa', e.target.value)} options={[{ value: '', label: 'Every villa' }, ...villas.map((v) => ({ value: v.id, label: v.name }))]} />
          <Button variant="card" className="ml-auto" disabled={apoa.length === 0} onClick={() => download(csvFileName(`apoa-${villas.find((v) => v.id === villaId)?.code ?? 'all'}`, date), toCsv(APOA_COLUMNS, apoa))}>
            <Download aria-hidden className="size-4" /> Export for APOA
          </Button>
        </div>
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No foreign guests that day">Pick another day or villa.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.key} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Pick ${r.person.name}`}
                  className="mt-1 size-4 shrink-0 accent-accent"
                  disabled={!!r.report || r.missing.length > 0 || !can('guest', 'edit')}
                  checked={picked.has(r.key)}
                  onChange={() => toggle(r.key)}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.kind === 'guest' ? (
                      <Link to={`/guests/${r.personId}`} className="hover:underline">
                        {r.person.name}
                      </Link>
                    ) : (
                      r.person.name
                    )}
                    {r.kind === 'companion' && <span className="ml-2 text-xs font-normal text-muted">companion</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {countryName(r.person.nationality)} · {ID_TYPE_LABEL[r.person.idType]} <span className="font-mono">{r.person.idNumber || 'no number'}</span> ·{' '}
                    <Link to={`/bookings/${r.booking.id}`} className="hover:underline">
                      {r.booking.code}
                    </Link>{' '}
                    {r.booking.unitCode}, {r.booking.place.villa.name} · in {shortDay(r.booking.checkedInOn ?? r.booking.checkIn)}
                  </p>
                  {r.missing.length > 0 && <p className="mt-1 text-xs font-medium text-warning">Missing: {r.missing.join(', ')}</p>}
                  {r.report && (
                    <p className="mt-1 text-xs text-muted">
                      Reported by {r.report.reportedBy} on {r.report.reportedAt.replace('T', ' ').slice(0, 16)}
                      {r.report.reference && <> · {r.report.reference}</>}
                    </p>
                  )}
                </div>
                {status(r)}
              </li>
            ))}
          </ul>
        )}
        {can('guest', 'edit') && ready.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line p-4">
            <Button variant="soft" size="sm" onClick={() => setPicked(new Set(ready.map((r) => r.key)))}>
              Pick all {ready.length} ready
            </Button>
            <Input aria-label="APOA reference" placeholder="APOA receipt number" value={reference} onChange={(e) => setReference(e.target.value)} className="h-10 w-56" />
            <Button variant="accent" disabled={picked.size === 0} loading={saving} onClick={() => void markReported()}>
              {!saving && <Send aria-hidden className="size-4" />} Mark {picked.size || ''} reported
            </Button>
            {error && (
              <p role="alert" className="w-full text-xs font-medium text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </Card>
      <p className="text-xs text-muted">
        Columns: {APOA_COLUMNS.join(', ')}. No public source shows an APOA upload template, so this order is an approximation; confirm it against the template in your APOA account. The public APOA guide confirms name, sex, date of birth, nationality, passport number and expiry, and APOA stamps the check-in and check-out dates.
      </p>
    </div>
  )
}
