import { clockLabel } from '@/domain/roomService'

/** "08:30" from an `<input type="time">` to minutes since midnight. */
export const toMinutes = (clock: string) => {
  const [h = '0', m = '0'] = clock.split(':')
  return Number(h) * 60 + Number(m)
}
export const toClock = (minutes: number) => clockLabel(Math.max(0, Math.min(24 * 60 - 1, minutes)))

/** Half an hour from now, rounded up to the quarter: the first time worth offering for an order. */
export const nextSlot = () => {
  const d = new Date()
  return Math.min(24 * 60 - 15, Math.ceil((d.getHours() * 60 + d.getMinutes() + 30) / 15) * 15)
}
