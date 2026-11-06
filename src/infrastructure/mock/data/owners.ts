import { namedFile } from '@/domain/attachment'
import { findConflicts, type UnitBlock } from '@/domain/booking'
import type { ContractInput, ManagementContract, OwnerStayRequest, VillaOwner } from '@/domain/owner'
import { addDays, addMonths, eachDay, startOfMonth } from '@/lib/dates'
import type { MockState } from '../state'

/** Two investors who hand their villas to the operator; Saka and Tirta stay the operator's own. */
export const VILLA_OWNERS: readonly VillaOwner[] = [
  { id: 'own-hendra', name: 'Hendra Gunawan', email: 'hendra@balivillas.id', phone: '+62 811 3900 214', bank: { bank: 'BCA', accountName: 'Hendra Gunawan', accountNumber: '0183 445 902' }, npwp: '09.254.294.3-407.000', userId: 'usr-hendra' },
  { id: 'own-sophie', name: 'Sophie Laurent', email: 'sophie@balivillas.id', phone: '+33 6 12 48 90 77', bank: { bank: 'Mandiri', accountName: 'Sophie Laurent', accountNumber: '145 00 1188 2207' }, npwp: '', userId: 'usr-sophie' },
]

export interface ContractSeed extends Omit<ContractInput, 'start' | 'end' | 'document'> {
  id: string
  number: string
  startDaysAgo: number
  /** Years the contract runs from its start. */
  years: number
  documentName: string
}

export const CONTRACT_SEEDS: readonly ContractSeed[] = [
  { id: 'ct-karang', number: 'MC-2025-01', villaId: 'vil-karang', ownerId: 'own-hendra', startDaysAgo: 420, years: 5, feeBasis: 'gop', feePct: 20, fixedMonthlyFee: 2_500_000, charged: 'operating', maintenanceThreshold: 0, ownerNightsPerYear: 28, ownerStayPricing: 'cleaning', ownerStayPrice: 350_000, reservePct: 3, payoutDay: 10, documentName: 'management-contract-villa-karang.pdf' },
  { id: 'ct-pandawa', number: 'MC-2025-02', villaId: 'vil-pandawa', ownerId: 'own-hendra', startDaysAgo: 420, years: 5, feeBasis: 'gross', feePct: 18, fixedMonthlyFee: 0, charged: 'all', maintenanceThreshold: 0, ownerNightsPerYear: 21, ownerStayPricing: 'free', ownerStayPrice: 0, reservePct: 4, payoutDay: 10, documentName: 'management-contract-villa-pandawa.pdf' },
  { id: 'ct-lumbung', number: 'MC-2025-03', villaId: 'vil-lumbung', ownerId: 'own-sophie', startDaysAgo: 300, years: 3, feeBasis: 'room', feePct: 25, fixedMonthlyFee: 0, charged: 'maintenance', maintenanceThreshold: 2_000_000, ownerNightsPerYear: 30, ownerStayPricing: 'rate', ownerStayPrice: 750_000, reservePct: 2, payoutDay: 10, documentName: 'management-contract-villa-lumbung.pdf' },
]

/** Contracts, a past owner stay at Karang last month where a unit was free, and one waiting at Lumbung. */
export function seedOwners(s: Pick<MockState, 'today' | 'bookings' | 'blocks' | 'units'>, signer: string) {
  const day = (offset: number) => addDays(s.today, offset)
  const contracts: ManagementContract[] = CONTRACT_SEEDS.map(({ startDaysAgo, years, documentName, ...c }) => {
    const start = day(-startDaysAgo)
    return { ...c, start, end: addDays(addMonths(start, 12 * years), -1), document: namedFile(documentName, signer, `${start}T10:00:00`), createdOn: start }
  })
  const blocks: UnitBlock[] = []
  const stays: OwnerStayRequest[] = []
  const lastMonth = addMonths(startOfMonth(s.today), -1)
  const karang = s.units.filter((u) => u.villaId === 'vil-karang')
  const free = eachDay(addDays(lastMonth, 4), addDays(lastMonth, 24))
    .flatMap((from) => karang.map((u) => ({ unitId: u.id, from, to: addDays(from, 3) })))
    .find((w) => findConflicts(w.unitId, w.from, w.to, s.bookings, s.blocks).length === 0)
  if (free) {
    blocks.push({ id: 'blk-owner-1', unitId: free.unitId, from: free.from, to: free.to, reason: 'owner', note: 'Owner stay OSR-001, Hendra Gunawan' })
    stays.push({ id: 'osr-1', number: 'OSR-001', contractId: 'ct-karang', ownerId: 'own-hendra', villaId: 'vil-karang', checkIn: free.from, checkOut: free.to, guests: 4, note: 'Family weekend', status: 'approved', requestedOn: addDays(free.from, -20), unitId: free.unitId, blockId: 'blk-owner-1', decidedBy: 'Kadek Ariani', decidedOn: addDays(free.from, -19), decisionNote: '' })
  }
  stays.push({ id: 'osr-2', number: 'OSR-002', contractId: 'ct-lumbung', ownerId: 'own-sophie', villaId: 'vil-lumbung', checkIn: day(40), checkOut: day(45), guests: 2, note: 'Arriving from Paris, late check-in please', status: 'pending', requestedOn: day(-2), unitId: null, blockId: null, decidedBy: null, decidedOn: null, decisionNote: '' })
  return { owners: VILLA_OWNERS.map((o) => ({ ...o, bank: { ...o.bank } })), contracts, blocks, stays }
}
