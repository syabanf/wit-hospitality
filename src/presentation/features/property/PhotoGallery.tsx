import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ImagePlus, Pencil, Star, Trash2 } from 'lucide-react'
import { MAX_PHOTOS, type Photo } from '@/domain/property'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { useToast } from '../../ui/useToast'
import { shrink } from '../shared/shrink'

export type ShownPhoto = Photo & { url: string }

const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic'
/** Photos shrink harder than receipts: the demo keeps them in the browser and the website serves them. */
const PHOTO_EDGE = 1280
const PHOTO_MIN_BYTES = 150_000

/** The cover large and the rest in a grid; with `onSave`, an editor to upload, caption, reorder and remove. */
export function PhotoGallery({ id, title, photos, onSave, empty }: { id: string; title: string; photos: readonly ShownPhoto[]; onSave?: (photos: Photo[]) => Promise<unknown>; empty: string }) {
  const [draft, setDraft] = useState<ShownPhoto[] | null>(null)
  const [cover, ...rest] = photos
  return (
    <Card aria-labelledby={id}>
      <CardHeader
        id={id}
        title={title}
        action={
          onSave &&
          !draft && (
            <Button size="sm" variant="soft" onClick={() => setDraft(photos.map((p) => ({ ...p })))}>
              <Pencil aria-hidden className="size-4" /> Edit photos
            </Button>
          )
        }
      />
      {draft && onSave ? (
        <PhotoEditor draft={draft} onChange={setDraft} onSave={onSave} onClose={() => setDraft(null)} />
      ) : !cover ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <div className="space-y-2">
          <figure className="overflow-hidden rounded-panel bg-raised">
            <img src={cover.url} alt={cover.caption || `${title}, cover`} className="aspect-[16/9] w-full object-cover" />
            {cover.caption && <figcaption className="px-3 py-2 text-xs text-muted">{cover.caption}</figcaption>}
          </figure>
          {rest.length > 0 && (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {rest.map((p) => (
                <li key={p.fileId}>
                  <img src={p.url} alt={p.caption || title} title={p.caption} className="aspect-square w-full rounded-xl bg-raised object-cover" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

function PhotoEditor({ draft, onChange, onSave, onClose }: { draft: ShownPhoto[]; onChange: (next: ShownPhoto[]) => void; onSave: (photos: Photo[]) => Promise<unknown>; onClose: () => void }) {
  const { files } = useServices()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(0)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('')
  /** Uploads finish one by one; each adds to the list as it stands then. */
  const latest = useRef(draft)
  useEffect(() => {
    latest.current = draft
  })

  const move = (from: number, to: number) => {
    const next = [...draft]
    const [p] = next.splice(from, 1)
    if (p) next.splice(to, 0, p)
    onChange(next)
  }

  async function add(list: FileList | null) {
    const picked = Array.from(list ?? []).slice(0, Math.max(0, MAX_PHOTOS - draft.length))
    setProblem('')
    for (const file of picked) {
      if (!file.type.startsWith('image/')) {
        setProblem(`${file.name} is not a photo.`)
        continue
      }
      setBusy((n) => n + 1)
      try {
        const stored = await files.upload(await shrink(file, PHOTO_EDGE, PHOTO_MIN_BYTES))
        latest.current = [...latest.current, { fileId: stored.id, caption: '', url: files.photoUrl(stored.id) || stored.url }]
        onChange(latest.current)
      } catch (error) {
        setProblem(error instanceof Error ? error.message : `${file.name} did not upload.`)
      } finally {
        setBusy((n) => n - 1)
      }
    }
    if (input.current) input.current.value = ''
  }

  async function save() {
    setSaving(true)
    try {
      await onSave(draft.map(({ fileId, caption }) => ({ fileId, caption: caption.trim() })))
      toast({ title: 'Saved the photos', description: draft.length ? 'The first photo is the cover.' : 'No photos left.' })
      onClose()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save the photos', description: error instanceof Error ? error.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      {draft.length === 0 && <p className="text-sm text-muted">No photos yet. Upload a few; the first one is the cover.</p>}
      <ol className="space-y-2" aria-label="Photos in order, the first is the cover">
        {draft.map((p, i) => (
          <li key={p.fileId} className="flex flex-wrap items-center gap-2 rounded-panel bg-raised p-2 sm:flex-nowrap">
            <img src={p.url} alt="" className="size-16 shrink-0 rounded-xl bg-control object-cover" />
            <Input aria-label={`Caption for photo ${i + 1}`} value={p.caption} maxLength={140} placeholder={i === 0 ? 'Cover caption' : 'Caption'} className="min-w-0 flex-1 basis-40" onChange={(e) => onChange(draft.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))} />
            <div className="flex shrink-0 gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={`Make photo ${i + 1} the cover`} disabled={i === 0} onClick={() => move(i, 0)}>
                <Star aria-hidden className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Move photo ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                <ArrowUp aria-hidden className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Move photo ${i + 1} down`} disabled={i === draft.length - 1} onClick={() => move(i, i + 1)}>
                <ArrowDown aria-hidden className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove photo ${i + 1}`} onClick={() => onChange(draft.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {problem && (
        <p role="alert" className="text-xs font-medium text-danger">
          {problem}
        </p>
      )}
      <input ref={input} type="file" accept={PHOTO_ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void add(e.target.files)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="soft" loading={busy > 0} disabled={draft.length >= MAX_PHOTOS} onClick={() => input.current?.click()}>
          {busy === 0 && <ImagePlus aria-hidden className="size-4" />} Upload photos
        </Button>
        <span className="text-xs text-muted">
          {draft.length} of {MAX_PHOTOS} · JPEG, PNG, WebP or HEIC
        </span>
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="accent" loading={saving} disabled={busy > 0} onClick={() => void save()}>
            Save photos
          </Button>
          <Button variant="soft" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
