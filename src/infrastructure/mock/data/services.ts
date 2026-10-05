import type { ServiceKind, ServicePriority, ServiceStatus } from '@/domain/roomService'

export interface ServiceSeed {
  seq: number
  unitCode: string
  /** Attach to the stay in that unit on the day; null for housekeeping without a guest. */
  withStay: boolean
  kind: ServiceKind
  priority: ServicePriority
  note: string
  charge: number
  status: ServiceStatus
  assignee: string
  daysAgo: number
  /** Minutes since midnight. */
  at: number
}

const req = (seq: number, unitCode: string, withStay: boolean, kind: ServiceKind, note: string, status: ServiceStatus, daysAgo: number, at: number, extra: Partial<ServiceSeed> = {}): ServiceSeed => ({
  seq,
  unitCode,
  withStay,
  kind,
  priority: 'normal',
  note,
  charge: 0,
  status,
  assignee: '',
  daysAgo,
  at,
  ...extra,
})

/** Three days of requests around today: open and in-progress work first, then what housekeeping closed. */
export const SERVICE_REQUESTS: readonly ServiceSeed[] = [
  req(1, 'SK-04', true, 'towels', 'Two extra bath towels and a hair dryer', 'open', 0, 8 * 60 + 40),
  req(2, 'SK-07', true, 'minibar', 'Refill water and two Bintang', 'open', 0, 9 * 60 + 5, { charge: 90_000 }),
  req(3, 'TR-03', true, 'laundry', 'Six pieces, express by tonight', 'in_progress', 0, 8 * 60 + 15, { charge: 180_000, assignee: 'Wayan' }),
  req(4, 'KR-03', true, 'maintenance', 'Pool light flickers after dusk', 'in_progress', 0, 7 * 60 + 50, { priority: 'urgent', assignee: 'Komang' }),
  req(5, 'LB-01', true, 'transfer', 'Pickup to the airport at 11:00 tomorrow, 3 pax', 'open', 0, 9 * 60 + 30, { charge: 350_000 }),
  req(6, 'SK-01', false, 'cleaning', 'Turnover clean before the 14:00 arrival', 'in_progress', 0, 7 * 60, { priority: 'urgent', assignee: 'Ketut' }),
  req(7, 'TR-01', false, 'cleaning', 'Turnover clean, pool suite', 'open', 0, 7 * 60 + 10, { assignee: 'Putu' }),
  req(8, 'KR-02', false, 'cleaning', 'Deep clean before the 6-night stay', 'done', 0, 6 * 60 + 30, { assignee: 'Putu' }),
  req(9, 'SK-08', true, 'other', 'Birthday cake for tonight, no nuts', 'done', 1, 10 * 60, { charge: 250_000, assignee: 'Kadek' }),
  req(10, 'LB-02', true, 'maintenance', 'AC remote not responding', 'done', 1, 14 * 60 + 20, { assignee: 'Komang' }),
  req(11, 'SK-05', false, 'cleaning', 'Late check-out clean', 'cancelled', 1, 12 * 60, { note: 'Late check-out clean; guest never arrived' }),
  req(12, 'TR-02', true, 'towels', 'Beach towels for two', 'done', 2, 9 * 60 + 45, { assignee: 'Wayan' }),
]
