import { useRef, useState, type PointerEvent } from 'react'
import type { Signed } from '@/domain/relations'
import { Button } from '../../ui/Button'

/** The guest signs with a finger or the mouse, or the desk marks that they signed the paper card. */
export function SignaturePad({ value, onChange, error, id }: { value: Signed; onChange: (s: Signed) => void; error?: string; id: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [drawn, setDrawn] = useState(false)

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height }
  }
  const start = (e: PointerEvent<HTMLCanvasElement>) => {
    const ctx = e.currentTarget.getContext('2d')
    if (!ctx) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    const p = point(e)
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    // Ink on white in both themes, like the paper card it replaces.
    ctx.strokeStyle = getComputedStyle(e.currentTarget).getPropertyValue('--color-ink').trim() || 'black'
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const ctx = e.currentTarget.getContext('2d')
    const p = point(e)
    ctx?.lineTo(p.x, p.y)
    ctx?.stroke()
  }
  const end = () => {
    if (!drawing.current || !canvas.current) return
    drawing.current = false
    setDrawn(true)
    onChange({ signature: 'drawn', signatureData: canvas.current.toDataURL('image/png') })
  }
  const clear = () => {
    const c = canvas.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setDrawn(false)
    onChange({ signature: 'drawn', signatureData: '' })
  }
  const paper = value.signature === 'paper'

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          Guest signature
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={paper} onChange={(e) => onChange(e.target.checked ? { signature: 'paper', signatureData: '' } : { signature: 'drawn', signatureData: '' })} className="size-4 accent-accent" />
          Signed on paper
        </label>
      </div>
      {!paper && (
        <div className="space-y-2">
          <canvas
            id={id}
            ref={canvas}
            width={480}
            height={140}
            aria-label="Sign here"
            className="h-28 w-full touch-none rounded-panel border border-line-strong bg-on-ink"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
          />
          {drawn && (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
