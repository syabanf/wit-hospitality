import { useRef } from 'react'
import { Camera, X } from 'lucide-react'
import { Button } from '../../ui/Button'

/** File names of photos; the demo keeps the names, the API stores the files. */
export function PhotoField({ id, value, onChange }: { id: string; value: readonly string[]; onChange: (names: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((name) => (
        <span key={name} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-raised pr-1 pl-3 text-xs">
          <span className="truncate">{name}</span>
          <button type="button" aria-label={`Remove ${name}`} className="grid size-6 cursor-pointer place-items-center rounded-full hover:bg-control" onClick={() => onChange(value.filter((n) => n !== name))}>
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const names = Array.from(e.target.files ?? []).map((f) => f.name)
          onChange([...value, ...names.filter((n) => !value.includes(n))])
          e.target.value = ''
        }}
      />
      <Button size="sm" variant="soft" onClick={() => input.current?.click()}>
        <Camera aria-hidden className="size-3.5" /> Add photos
      </Button>
    </div>
  )
}
