import { Link, useSearchParams } from 'react-router'
import { Search, SlidersHorizontal } from 'lucide-react'
import { CHANNEL_LABEL, MESSAGE_CHANNELS, MESSAGE_STATUS_LABEL, MESSAGE_STATUSES, type MessageChannel, type MessageStatus, type TemplateKey } from '@/domain/messaging'
import { shortDay } from '@/lib/dates'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { MessageLog } from './parts'
import { MESSAGE_TONE } from './tones'

type StatusChip = MessageStatus | 'all'

/** Every outbound guest message with its status; filters live in the URL. */
export default function MessagesPage() {
  const { messaging, clock } = useServices()
  const { can } = useAccess()
  const data = useResource('messaging.list', () => messaging.list())
  const [params, setParams] = useSearchParams()
  const get = (k: string) => params.get(k) ?? ''
  const status = (MESSAGE_STATUSES.find((x) => x === get('status')) ?? 'all') as StatusChip
  const channel = (MESSAGE_CHANNELS.find((x) => x === get('channel')) ?? '') as MessageChannel | ''
  const template = get('template') as TemplateKey | 'free' | ''

  function update(next: Record<string, string | undefined>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v && v !== 'all') search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const base = messaging.filter(d.list, { channel, templateKey: template, query: get('q'), from: get('from') || undefined, to: get('to') || undefined })
  const rows = status === 'all' ? base : base.filter((m) => m.status === status)
  const failed = d.list.filter((m) => m.status === 'failed')

  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Sent today" value={d.list.filter((m) => m.queuedAt.startsWith(d.today)).length} hint="By triggers and staff" />
        <StatTile label="Delivered" value={base.filter((m) => m.status === 'delivered').length} active={status === 'delivered'} onClick={() => update({ status: status === 'delivered' ? 'all' : 'delivered' })} />
        <StatTile label="Read" value={base.filter((m) => m.status === 'read').length} active={status === 'read'} onClick={() => update({ status: status === 'read' ? 'all' : 'read' })} />
        <StatTile label="Failed" value={failed.length} hint="Resend from the row" active={status === 'failed'} onClick={() => update({ status: status === 'failed' ? 'all' : 'failed' })} />
      </div>
      {status === 'failed' && failed.length > 0 && (
        <Card aria-label="Failed messages">
          <MessageLog messages={failed} canSend={can('booking', 'edit')} onChanged={data.reload} showStay empty="" />
        </Card>
      )}
      <Card className="p-0">
        <TableToolbar
          chips={(['all', ...MESSAGE_STATUSES] as StatusChip[]).map((x) => ({ value: x, label: x === 'all' ? 'All' : MESSAGE_STATUS_LABEL[x], count: x === 'all' ? base.length : base.filter((m) => m.status === x).length }))}
          chip={status}
          onChip={(x) => update({ status: x })}
          summary={`${rows.length} of ${d.list.length} messages`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Guest, booking, number or text" aria-label="Search messages" value={get('q')} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Channel" value={channel} options={[{ value: '', label: 'Every channel' }, ...MESSAGE_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))]} onChange={(e) => update({ channel: e.target.value })} />
              <Select aria-label="Template" value={template} options={[{ value: '', label: 'Every template' }, ...d.templates.map((t) => ({ value: t.key, label: t.name })), { value: 'free', label: 'Free messages' }]} onChange={(e) => update({ template: e.target.value })} />
              <Link to="/messages/settings" className={buttonStyles({ variant: 'soft' })}>
                <SlidersHorizontal aria-hidden className="size-4" /> Templates
              </Link>
            </>
          }
          date={<DateRangeFilter today={clock.today()} label="Sent" value={{ from: get('from') || undefined, to: get('to') || undefined }} onChange={(r) => update({ from: r.from, to: r.to })} />}
          active={params.size > 0}
          onClear={() => setParams({}, { replace: true })}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="Messages"
            rows={rows}
            rowKey={(m) => m.id}
            href={(m) => `/bookings/${m.bookingId}`}
            defaultSort={{ key: 'at', dir: 'desc' }}
            exportName="messages"
            exportDate={d.today}
            empty={<EmptyState title="No message matches">Clear a filter to see more.</EmptyState>}
            columns={[
              { key: 'guest', header: 'Guest', cell: (m) => m.guestName, value: (m) => m.guestName },
              { key: 'template', header: 'Message', cell: (m) => m.templateName, value: (m) => m.templateName },
              { key: 'booking', header: 'Booking', cell: (m) => <span className="font-mono text-xs">{m.bookingCode}</span>, value: (m) => m.bookingCode, hide: 'lg' },
              { key: 'channel', header: 'Channel', cell: (m) => CHANNEL_LABEL[m.channel], value: (m) => CHANNEL_LABEL[m.channel], hide: 'lg' },
              { key: 'to', header: 'To', cell: (m) => <span className="text-xs">{m.to}</span>, value: (m) => m.to, hide: 'xl' },
              { key: 'by', header: 'Sent by', cell: (m) => m.sentBy, value: (m) => m.sentBy, hide: 'xl' },
              { key: 'at', header: 'Sent', cell: (m) => `${shortDay(m.queuedAt.slice(0, 10))} ${m.queuedAt.slice(11, 16)}`, value: (m) => m.queuedAt },
              { key: 'status', header: 'Status', cell: (m) => <StatusPill tone={MESSAGE_TONE[m.status]}>{MESSAGE_STATUS_LABEL[m.status]}</StatusPill>, value: (m) => MESSAGE_STATUS_LABEL[m.status] },
            ]}
            card={(m) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.guestName}</p>
                  <p className="truncate text-xs text-muted">
                    {m.templateName} · {CHANNEL_LABEL[m.channel]} · {shortDay(m.queuedAt.slice(0, 10))}
                  </p>
                </div>
                <StatusPill tone={MESSAGE_TONE[m.status]}>{MESSAGE_STATUS_LABEL[m.status]}</StatusPill>
              </div>
            )}
          />
        </div>
      </Card>
    </div>
  )
}
