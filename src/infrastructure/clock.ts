import type { Clock } from '@/application/ports'
import type { IsoDate } from '@/lib/dates'

/** Today in the viewer's own time zone. */
export const systemClock: Clock = {
  today: () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  },
}

/** A pinned day for tests, at ten in the morning unless told otherwise. */
export const fixedClock = (today: IsoDate, time = '10:00'): Clock => ({ today: () => today, time: () => time })
