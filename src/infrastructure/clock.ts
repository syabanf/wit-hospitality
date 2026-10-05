import type { Clock } from '@/application/ports'
import type { IsoDate } from '@/lib/dates'

/** Today in the viewer's own time zone. */
export const systemClock: Clock = {
  today: () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  },
}

export const fixedClock = (today: IsoDate): Clock => ({ today: () => today })
