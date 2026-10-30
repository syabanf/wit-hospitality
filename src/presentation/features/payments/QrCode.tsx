import { qrGrid } from '@/domain/payment'
import { cn } from '@/lib/cn'

/** A QRIS-style code drawn from the payload. Demo only: it is not a scannable QR. */
export function QrCode({ payload, className }: { payload: string; className?: string }) {
  const grid = qrGrid(payload)
  const n = grid.length
  return (
    <svg viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label="QRIS code" className={cn('rounded-xl bg-white text-ink', className)} shapeRendering="crispEdges">
      {grid.flatMap((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" /> : null)))}
    </svg>
  )
}
