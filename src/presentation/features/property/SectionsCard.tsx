import { useState, type FormEvent } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { Unit } from '@/domain/property'
import type { Section, SectionInput } from '@/domain/section'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { CheckboxGrid } from '../../ui/CheckboxGrid'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { EmptyState } from '../../ui/States'
import { useToast } from '../../ui/useToast'

/**
 * Sections of a hotel or mixed property: named sets of rooms housekeeping hands to one attendant
 * for the day. Each room sits in one section at most.
 */
export function SectionsCard({ villaId, rooms, mayEdit }: { villaId: string; rooms: readonly Unit[]; mayEdit: boolean }) {
  const { desk } = useServices()
  const toast = useToast()
  const data = useResource(`desk.sections:${villaId}`, () => desk.sections(villaId))
  /** The section being edited: 'new', a section id, or null. */
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<SectionInput>({ villaId, name: '', unitIds: [] })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const sections = data.data ?? []
  const code = (id: string) => rooms.find((u) => u.id === id)?.code ?? id

  const open = (s: Section | null) => {
    setErrors({})
    setEditing(s ? s.id : 'new')
    setForm(s ? { villaId, name: s.name, unitIds: [...s.unitIds] } : { villaId, name: '', unitIds: [] })
  }
  async function act(label: string, run: () => Promise<unknown>) {
    setBusy(true)
    setErrors({})
    try {
      await run()
      toast({ title: label })
      setEditing(null)
      data.reload()
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: 'Could not save the section', description: Object.values(e)[0] })
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void act(editing === 'new' ? `Added ${form.name.trim()}` : `Saved ${form.name.trim()}`, () => desk.saveSection(editing === 'new' ? null : editing, form))
  }
  // A room already in another section is left out of the picker.
  const taken = new Set(sections.filter((s) => s.id !== editing).flatMap((s) => s.unitIds))

  return (
    <Card aria-labelledby="sections-title">
      <CardHeader
        id="sections-title"
        title="Housekeeping sections"
        action={
          mayEdit && editing === null ? (
            <Button size="sm" variant="soft" onClick={() => open(null)}>
              <Plus aria-hidden className="size-4" /> Section
            </Button>
          ) : undefined
        }
      />
      {editing !== null && (
        <form onSubmit={submit} className="mb-4 space-y-3 rounded-panel bg-raised p-3">
          <Field label="Name" htmlFor="section-name" error={errors.name}>
            <Input id="section-name" value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="East wing" />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Rooms</legend>
            <CheckboxGrid name="section-rooms" options={rooms.filter((u) => !taken.has(u.id)).map((u) => ({ id: u.id, label: u.code }))} selected={form.unitIds} onChange={(unitIds) => setForm({ ...form, unitIds })} />
            {(errors.unitIds || errors.form) && <p className="mt-1 text-xs font-medium text-danger">{errors.unitIds ?? errors.form}</p>}
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="accent" loading={busy}>
              Save section
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {sections.length === 0 ? (
        <EmptyState title="No sections">Group rooms into sections to give each run of rooms to one attendant for the day.</EmptyState>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {sections.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.name}</span>
                <span className="block truncate font-mono text-xs text-muted">{s.unitIds.map(code).join(', ')}</span>
              </span>
              {mayEdit && (
                <span className="flex gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${s.name}`} onClick={() => open(s)}>
                    <Pencil aria-hidden className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name}`} disabled={busy} onClick={() => void act(`Removed ${s.name}`, () => desk.removeSection(s.id))}>
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
