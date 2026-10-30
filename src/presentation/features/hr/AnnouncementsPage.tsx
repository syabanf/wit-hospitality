import { useState, type FormEvent } from 'react'
import { Megaphone, Pencil, Pin, Plus, Search, Trash2 } from 'lucide-react'
import type { Announcement, AnnouncementInput } from '@/domain/people'
import { shortDay } from '@/lib/dates'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { Switch } from '../../ui/Switch'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { useFilters } from './useFilters'

/** Company notices for the employee area: pinned ones stay on top, villa ones reach one team. */
export default function AnnouncementsPage() {
  const { people } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('people.announcements', () => people.announcements())
  const { values, set, clear, active } = useFilters(['q', 'villa', 'pinned'] as const)
  const [editing, setEditing] = useState<{ id: string | null; pinned: boolean } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!editing) return
    const f = new FormData(e.currentTarget)
    const input: AnnouncementInput = { title: String(f.get('title') ?? ''), body: String(f.get('body') ?? ''), pinned: editing.pinned, villaId: String(f.get('villa') ?? '') || null }
    setBusy('save')
    setErrors({})
    try {
      const a = editing.id ? await people.updateAnnouncement(editing.id, input) : await people.createAnnouncement(input)
      toast({ title: editing.id ? 'Notice saved' : 'Notice published', description: a.title })
      setEditing(null)
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setBusy(null)
    }
  }

  async function remove(a: Announcement) {
    setBusy(a.id)
    try {
      await people.deleteAnnouncement(a.id)
      toast({ title: 'Notice removed', description: a.title })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not remove the notice', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const current = editing?.id ? d.announcements.find((a) => a.id === editing.id) : undefined
  const villaName = (id: string | null) => (id ? (d.catalog.villas.find((v) => v.id === id)?.name ?? id) : 'Everyone')
  const q = values.q.trim().toLowerCase()
  const rows = d.announcements.filter((a) => (!q || [a.title, a.body, a.by].some((v) => v.toLowerCase().includes(q))) && (!values.villa || (values.villa === 'all' ? a.villaId === null : a.villaId === values.villa)) && (!values.pinned || a.pinned))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">What the team sees on the employee home. Pin the ones that matter this week.</p>
        {can('hr', 'create') && (
          <Button variant="accent" aria-pressed={Boolean(editing && !editing.id)} onClick={() => setEditing(editing && !editing.id ? null : { id: null, pinned: false })}>
            <Plus aria-hidden className="size-4" /> New notice
          </Button>
        )}
      </div>
      {editing && (
        <Card as="div" aria-label={current ? 'Edit notice' : 'New notice'}>
          <form key={editing.id ?? 'new'} onSubmit={(e) => void save(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="an-title" error={errors.title}>
              <Input id="an-title" name="title" defaultValue={current?.title} />
            </Field>
            <Field label="Audience" htmlFor="an-villa">
              <Select id="an-villa" name="villa" className="w-full" defaultValue={current?.villaId ?? ''} options={[{ value: '', label: 'Everyone' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: `${v.name} team` }))]} />
            </Field>
            <Field label="Notice" htmlFor="an-body" error={errors.body ?? errors.form} className="sm:col-span-2">
              <Textarea id="an-body" name="body" rows={4} defaultValue={current?.body} />
            </Field>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Switch label="Pinned" checked={editing.pinned} onChange={(on) => setEditing({ ...editing, pinned: on })} />
              <span className="text-sm">Pin to the top</span>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" variant="accent" loading={busy === 'save'}>
                {current ? 'Save notice' : 'Publish'}
              </Button>
              <Button variant="soft" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      <Card className="p-0">
        <TableToolbar
          chips={[
            { value: '', label: 'All', count: d.announcements.length },
            { value: 'yes', label: 'Pinned', count: d.announcements.filter((a) => a.pinned).length },
          ]}
          chip={values.pinned ? 'yes' : ''}
          chipLabel="Pinned filter"
          onChip={(c) => set({ pinned: c })}
          summary={`${rows.length} of ${d.announcements.length} notices`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Title, text or author" aria-label="Search notices" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
          filters={<Select aria-label="Audience" value={values.villa} options={[{ value: '', label: 'Every audience' }, { value: 'all', label: 'Everyone' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: `${v.name} team` }))]} onChange={(e) => set({ villa: e.target.value })} />}
          active={active}
          onClear={clear}
        />
        <p className="sr-only">Notices follow below.</p>
      </Card>
      {rows.length === 0 ? (
        <EmptyState title={d.announcements.length ? 'No notice matches' : 'No notices yet'} action={active ? <Button size="sm" variant="solid" onClick={clear}>Clear filters</Button> : undefined} />
      ) : (
        <ul className="stagger grid grid-cols-1 gap-4 md:grid-cols-2">
          {rows.map((a) => (
            <li key={a.id}>
              <Card as="article" aria-label={a.title} className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-raised text-muted">{a.pinned ? <Pin aria-hidden className="size-5" /> : <Megaphone aria-hidden className="size-5" />}</span>
                  <div className="flex items-center gap-1.5">
                    {a.pinned && <Tag tone="accent">Pinned</Tag>}
                    <Tag tone={a.villaId ? 'info' : 'neutral'}>{villaName(a.villaId)}</Tag>
                  </div>
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight">{a.title}</h2>
                <p className="mt-1 flex-1 text-sm text-body">{a.body}</p>
                <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted">
                  <span>
                    {a.by} · {shortDay(a.publishedOn)}
                  </span>
                  {can('hr', 'edit') && (
                    <span className="flex gap-1">
                      <Button size="icon-sm" variant="ghost" aria-label={`Edit ${a.title}`} onClick={() => setEditing({ id: a.id, pinned: a.pinned })}>
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${a.title}`} loading={busy === a.id} onClick={() => void remove(a)}>
                        {busy !== a.id && <Trash2 aria-hidden className="size-4" />}
                      </Button>
                    </span>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
