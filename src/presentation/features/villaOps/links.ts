import type { CheckKind } from '@/domain/unitInventory'
import type { MeterReading } from '@/domain/utilities'
import { money } from '@/lib/format'

export const checkHref = (unitId: string, bookingId: string, kind: CheckKind) => `/housekeeping/checks/new?unit=${unitId}&booking=${bookingId}&kind=${kind}`

export const billedLine = (r: Pick<MeterReading, 'amount' | 'billedTo'>) => (r.billedTo ? `${money(r.amount)} to the ${r.billedTo}` : 'Not billed')
