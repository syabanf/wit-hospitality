import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Camera, FileText, Paperclip, Upload, X } from 'lucide-react'
import { ATTACHMENT_ACCEPT, fileSize, isImage, isPdf, MAX_ATTACHMENTS, type Attachment, type UploadFile } from '@/domain/attachment'
import { cn } from '@/lib/cn'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'

/** Phone photos run to several MB; this keeps receipts readable at a fraction of the size. */
const MAX_EDGE = 1600

async function shrink(file: File): Promise<UploadFile> {
  const raw = { name: file.name, type: file.type, size: file.size, data: file }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 400_000) return raw
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.8))
    if (!blob || blob.size >= file.size) return raw
    return { name: file.name.replace(/\.\w+$/, '.jpg'), type: 'image/jpeg', size: blob.size, data: blob }
  } catch {
    return raw
  }
}

/** Thumbnails that open a preview; `onRemove` adds a remove button while the record can still change. */
export function AttachmentList({ files, onRemove, empty }: { files: readonly Attachment[]; onRemove?: (file: Attachment) => void; empty?: string }) {
  const [open, setOpen] = useState<Attachment | null>(null)
  if (files.length === 0) return empty ? <p className="text-sm text-muted">{empty}</p> : null
  return (
    <>
      <ul className="flex flex-wrap gap-2">
        {files.map((f) => (
          <li key={f.id} className="group relative">
            <button
              type="button"
              onClick={() => f.url && setOpen(f)}
              disabled={!f.url}
              title={f.url ? `Open ${f.name}` : `${f.name}: recorded before uploads, name only`}
              className="flex w-28 flex-col overflow-hidden rounded-panel border border-line-strong bg-raised text-left transition-colors enabled:hover:border-fg disabled:cursor-default"
            >
              <span className="grid h-20 place-items-center overflow-hidden bg-control">
                {f.url && isImage(f) ? <img src={f.url} alt="" className="size-full object-cover" /> : isPdf(f) ? <FileText aria-hidden className="size-7 text-muted" /> : <Paperclip aria-hidden className="size-6 text-muted" />}
              </span>
              <span className="truncate px-2 pt-1.5 text-xs font-medium">{f.name}</span>
              <span className="truncate px-2 pb-1.5 text-[11px] text-muted">{f.size > 0 ? fileSize(f.size) : 'Name only'} · {f.uploadedBy}</span>
            </button>
            {onRemove && (
              <Button variant="card" size="icon-sm" aria-label={`Remove ${f.name}`} className="absolute -top-2 -right-2 size-7" onClick={() => onRemove(f)}>
                <X aria-hidden className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {open && <Preview file={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function Preview({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    close.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label={file.name} className="fixed inset-0 z-50 flex flex-col bg-ink/80 p-4 animate-fade">
      <div className="mb-3 flex items-center gap-3 text-white">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
        <a href={file.url} download={file.name} className="text-sm underline">
          Download
        </a>
        <Button ref={close} variant="card" size="icon" aria-label="Close preview" onClick={onClose}>
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <button type="button" aria-label="Close preview" className="absolute inset-0 -z-10" onClick={onClose} />
      <div className="grid min-h-0 flex-1 place-items-center">
        {isPdf(file) ? <iframe src={file.url} title={file.name} className="size-full rounded-panel bg-white" /> : <img src={file.url} alt={file.name} className="max-h-full max-w-full rounded-panel object-contain" />}
      </div>
    </div>
  )
}

interface PickerProps {
  value: readonly Attachment[]
  onChange: (files: Attachment[]) => void
  /** Defaults to the signed-in upload; the guest checkout passes its own. */
  upload?: (file: UploadFile) => Promise<Attachment>
  id?: string
  hint?: string
  /** False where a file, once sent, stays: the guest checkout. */
  removable?: boolean
}

/** Pick, drop or photograph receipts; each file uploads as it is added. */
export function AttachmentPicker({ value, onChange, upload, id = 'attachments', hint = 'Photos or PDF, up to 5 MB each', removable = true }: PickerProps) {
  const { files: store } = useServices()
  const send = upload ?? store.upload
  const [busy, setBusy] = useState(0)
  const [problems, setProblems] = useState<string[]>([])
  const [over, setOver] = useState(false)
  /** Uploads finish one by one; each adds to the list as it stands then. */
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
  })

  async function add(list: FileList | null) {
    const picked = Array.from(list ?? []).slice(0, Math.max(0, MAX_ATTACHMENTS - value.length))
    if (picked.length === 0) return
    setProblems([])
    setBusy((n) => n + picked.length)
    const failed: string[] = []
    for (const file of picked) {
      try {
        const stored = await send(await shrink(file))
        onChange([...latest.current, stored])
      } catch (e) {
        failed.push(e instanceof Error ? e.message : `${file.name} did not upload.`)
      } finally {
        setBusy((n) => n - 1)
      }
    }
    setProblems(failed)
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void add(e.dataTransfer.files)
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn('flex flex-wrap items-center gap-2 rounded-panel border border-dashed p-3 transition-colors', over ? 'border-accent bg-accent-soft' : 'border-line-strong')}
      >
        <label htmlFor={id} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-control px-3.5 text-sm font-medium hover:bg-line focus-within:outline-2 focus-within:outline-accent">
          <Upload aria-hidden className="size-4" /> Add files
          <input id={id} type="file" multiple accept={ATTACHMENT_ACCEPT} className="sr-only" onChange={(e) => void add(e.currentTarget.files).then(() => (e.target.value = ''))} />
        </label>
        <label htmlFor={`${id}-camera`} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-control px-3.5 text-sm font-medium hover:bg-line focus-within:outline-2 focus-within:outline-accent md:hidden">
          <Camera aria-hidden className="size-4" /> Take photo
          <input id={`${id}-camera`} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void add(e.currentTarget.files).then(() => (e.target.value = ''))} />
        </label>
        <span className="text-xs text-muted">{busy > 0 ? `Uploading ${busy} file${busy > 1 ? 's' : ''}…` : `${hint}, or drop them here`}</span>
      </div>
      {problems.map((p) => (
        <p key={p} role="alert" className="text-sm font-medium text-danger">
          {p}
        </p>
      ))}
      <AttachmentList files={value} onRemove={removable ? (f) => onChange(value.filter((x) => x.id !== f.id)) : undefined} />
    </div>
  )
}
