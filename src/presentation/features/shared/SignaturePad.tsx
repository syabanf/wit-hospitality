import { useRef, useState, type PointerEvent } from 'react'
import { Eraser, PenLine } from 'lucide-react'
import { Button } from '../../ui/Button'

interface SignaturePadProps {
  /** Receives the drawing as a PNG; the pad stays as it is if the save fails. */
  onSign: (png: Blob) => Promise<unknown>
  saving?: boolean
  label?: string
  error?: string
}

/** A canvas the guest signs with a finger, a pen or the mouse; pointer events cover all three. */
export function SignaturePad({ onSign, saving = false, label = 'Save signature', error }: SignaturePadProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [inked, setInked] = useState(false)

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
  }
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = point(e)
  }
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const from = last.current
    const ctx = e.currentTarget.getContext('2d')
    if (!from || !ctx) return
    const to = point(e)
    ctx.strokeStyle = '#101112'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    last.current = to
    setInked(true)
  }
  const up = () => {
    last.current = null
  }
  const clear = () => {
    const c = canvas.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setInked(false)
  }
  const save = () => canvas.current?.toBlob((png) => png && void onSign(png), 'image/png')

  return (
    <div className="space-y-2">
      <canvas
        ref={canvas}
        width={600}
        height={200}
        aria-label="Signature pad: sign with a finger, a pen or the mouse"
        role="img"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        className="block h-40 w-full touch-none rounded-panel border border-dashed border-line-strong bg-white"
      />
      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="accent" loading={saving} disabled={!inked} onClick={save}>
          {!saving && <PenLine aria-hidden className="size-4" />} {label}
        </Button>
        <Button variant="soft" onClick={clear} disabled={!inked}>
          <Eraser aria-hidden className="size-4" /> Clear
        </Button>
      </div>
    </div>
  )
}
