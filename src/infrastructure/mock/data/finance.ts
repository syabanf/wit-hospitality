import type { AccountKind, Category, TransactionKind, TransactionStatus } from '@/domain/finance'

export interface AccountSeed {
  id: string
  name: string
  kind: AccountKind
  locationId: string | null
  openingBalance: number
  openedDaysAgo: number
}

export const ACCOUNTS: readonly AccountSeed[] = [
  { id: 'cb-canggu', name: 'Canggu cashbox', kind: 'cashbox', locationId: 'loc-canggu', openingBalance: 12_500_000, openedDaysAgo: 60 },
  { id: 'cb-ubud', name: 'Ubud cashbox', kind: 'cashbox', locationId: 'loc-ubud', openingBalance: 8_000_000, openedDaysAgo: 60 },
  { id: 'cb-seminyak', name: 'Seminyak cashbox', kind: 'cashbox', locationId: 'loc-seminyak', openingBalance: 9_000_000, openedDaysAgo: 60 },
  { id: 'cb-uluwatu', name: 'Uluwatu cashbox', kind: 'cashbox', locationId: 'loc-uluwatu', openingBalance: 6_000_000, openedDaysAgo: 60 },
  { id: 'bank-bca', name: 'BCA operating account', kind: 'bank', locationId: null, openingBalance: 145_000_000, openedDaysAgo: 60 },
]

export const CATEGORIES: readonly Category[] = [
  { id: 'cat-room', name: 'Room revenue', kind: 'cash_in', slot: 1, active: true },
  { id: 'cat-airbnb', name: 'Airbnb payout', kind: 'cash_in', slot: 2, active: true },
  { id: 'cat-extra', name: 'Extra services', kind: 'cash_in', slot: 3, active: true },
  { id: 'cat-deposit', name: 'Security deposit', kind: 'cash_in', slot: 4, active: true },
  { id: 'cat-util', name: 'Utilities', kind: 'cash_out', slot: 1, active: true },
  { id: 'cat-house', name: 'Housekeeping supplies', kind: 'cash_out', slot: 2, active: true },
  { id: 'cat-maint', name: 'Maintenance', kind: 'cash_out', slot: 3, active: true },
  { id: 'cat-staff', name: 'Staff and transport', kind: 'cash_out', slot: 4, active: true },
  { id: 'cat-mkt', name: 'Marketing', kind: 'cash_out', slot: 5, active: true },
  { id: 'cat-other', name: 'Other', kind: 'cash_out', slot: 0, active: true },
  { id: 'cat-pool', name: 'Pool chemicals', kind: 'cash_out', slot: 0, active: false },
]

export interface TransactionSeed {
  /** Sequence inside the number: TX-24xx. */
  seq: number
  daysAgo: number
  accountId: string
  kind: TransactionKind
  categoryId: string
  amount: number
  locationId: string
  villaId: string | null
  unitId: string | null
  bookingId: string | null
  description: string
  status: TransactionStatus
  reversalOfSeq?: number
}

const tx = (
  seq: number,
  daysAgo: number,
  accountId: string,
  kind: TransactionKind,
  categoryId: string,
  amount: number,
  locationId: string,
  villaId: string | null,
  unitId: string | null,
  description: string,
  status: TransactionStatus = 'posted',
  extra: Partial<Pick<TransactionSeed, 'bookingId' | 'reversalOfSeq'>> = {},
): TransactionSeed => ({ seq, daysAgo, accountId, kind, categoryId, amount, locationId, villaId, unitId, bookingId: null, description, status, ...extra })

/** Six weeks of money through the cashboxes and the bank, oldest first. */
export const TRANSACTIONS: readonly TransactionSeed[] = [
  tx(1, 44, 'bank-bca', 'cash_in', 'cat-airbnb', 31_250_000, 'loc-canggu', 'vil-saka', null, 'Airbnb payout, Saka Stays, August second half'),
  tx(2, 43, 'cb-canggu', 'cash_out', 'cat-util', 4_180_000, 'loc-canggu', 'vil-saka', null, 'PLN electricity, Villa Saka'),
  tx(3, 41, 'cb-ubud', 'cash_in', 'cat-room', 7_920_000, 'loc-ubud', 'vil-tirta', 'unit-tr-03', 'Direct stay payment, TR-03'),
  tx(4, 40, 'cb-seminyak', 'cash_out', 'cat-house', 1_350_000, 'loc-seminyak', 'vil-lumbung', null, 'Linen and amenities restock'),
  tx(5, 38, 'cb-uluwatu', 'cash_out', 'cat-maint', 2_750_000, 'loc-uluwatu', 'vil-karang', 'unit-kr-02', 'AC service, KR-02'),
  tx(6, 36, 'bank-bca', 'cash_in', 'cat-airbnb', 18_400_000, 'loc-ubud', 'vil-tirta', null, 'Airbnb payout, Ubud Retreats'),
  tx(7, 35, 'cb-canggu', 'cash_out', 'cat-staff', 900_000, 'loc-canggu', 'vil-saka', null, 'Staff transport, Canggu'),
  tx(8, 33, 'cb-canggu', 'cash_in', 'cat-extra', 1_200_000, 'loc-canggu', 'vil-saka', 'unit-sk-04', 'Airport pickup and late check-out'),
  tx(9, 31, 'cb-seminyak', 'cash_in', 'cat-room', 5_670_000, 'loc-seminyak', 'vil-lumbung', 'unit-lb-03', 'Direct stay payment, LB-03'),
  tx(10, 30, 'bank-bca', 'cash_out', 'cat-mkt', 3_500_000, 'loc-canggu', null, null, 'Instagram campaign, September'),
  tx(11, 29, 'cb-ubud', 'cash_out', 'cat-util', 2_640_000, 'loc-ubud', 'vil-tirta', null, 'PDAM water and PLN, Villa Tirta'),
  tx(12, 28, 'bank-bca', 'cash_in', 'cat-airbnb', 27_900_000, 'loc-seminyak', 'vil-lumbung', null, 'Airbnb payout, Bali Escapes, Seminyak'),
  tx(13, 27, 'cb-uluwatu', 'cash_in', 'cat-deposit', 3_000_000, 'loc-uluwatu', 'vil-karang', 'unit-kr-01', 'Security deposit, KR-01'),
  tx(14, 26, 'cb-canggu', 'cash_out', 'cat-maint', 6_800_000, 'loc-canggu', 'vil-saka', 'unit-sk-07', 'Pool pump quote deposit', 'reversed'),
  tx(15, 25, 'cb-canggu', 'cash_in', 'cat-maint', 6_800_000, 'loc-canggu', 'vil-saka', 'unit-sk-07', 'Reversal of TX-2414: supplier refunded the deposit', 'posted', { reversalOfSeq: 14 }),
  tx(16, 24, 'cb-seminyak', 'cash_out', 'cat-house', 780_000, 'loc-seminyak', 'vil-lumbung', null, 'Cleaning chemicals'),
  tx(17, 22, 'cb-uluwatu', 'cash_out', 'cat-other', 3_000_000, 'loc-uluwatu', 'vil-karang', 'unit-kr-01', 'Security deposit returned, KR-01'),
  tx(18, 21, 'cb-ubud', 'cash_in', 'cat-room', 10_560_000, 'loc-ubud', 'vil-tirta', 'unit-tr-01', 'Direct stay payment, TR-01'),
  tx(19, 20, 'bank-bca', 'cash_out', 'cat-staff', 24_000_000, 'loc-canggu', null, null, 'September salaries, all villas'),
  tx(20, 18, 'cb-canggu', 'cash_out', 'cat-util', 1_150_000, 'loc-canggu', 'vil-saka', null, 'Internet, Villa Saka'),
  tx(21, 17, 'cb-seminyak', 'cash_in', 'cat-extra', 650_000, 'loc-seminyak', 'vil-lumbung', 'unit-lb-01', 'Laundry service'),
  tx(22, 16, 'bank-bca', 'cash_out', 'cat-other', 1_500_000, 'loc-seminyak', null, null, 'Bank fees and admin'),
  tx(23, 15, 'bank-bca', 'cash_in', 'cat-airbnb', 29_600_000, 'loc-canggu', 'vil-saka', null, 'Airbnb payout, Saka Stays, September first half'),
  tx(24, 14, 'cb-uluwatu', 'cash_out', 'cat-maint', 1_900_000, 'loc-uluwatu', 'vil-karang', 'unit-kr-03', 'Gate motor repair'),
  tx(25, 13, 'cb-ubud', 'cash_out', 'cat-house', 1_020_000, 'loc-ubud', 'vil-tirta', null, 'Towels and toiletries'),
  tx(26, 12, 'cb-canggu', 'cash_in', 'cat-room', 6_660_000, 'loc-canggu', 'vil-saka', 'unit-sk-06', 'Direct stay payment, SK-06'),
  tx(27, 11, 'cb-seminyak', 'cash_out', 'cat-util', 3_420_000, 'loc-seminyak', 'vil-lumbung', null, 'PLN electricity, Villa Lumbung'),
  tx(28, 10, 'bank-bca', 'cash_in', 'cat-airbnb', 21_300_000, 'loc-uluwatu', 'vil-karang', null, 'Airbnb payout, Bali Escapes, Uluwatu'),
  tx(29, 9, 'cb-uluwatu', 'cash_out', 'cat-staff', 1_250_000, 'loc-uluwatu', 'vil-karang', null, 'Night guard overtime'),
  tx(30, 8, 'cb-canggu', 'cash_out', 'cat-other', 450_000, 'loc-canggu', 'vil-saka', null, 'Banjar contribution'),
  tx(31, 7, 'cb-ubud', 'cash_in', 'cat-extra', 1_800_000, 'loc-ubud', 'vil-tirta', 'unit-tr-02', 'Private chef dinner'),
  tx(32, 6, 'cb-seminyak', 'cash_in', 'cat-room', 7_560_000, 'loc-seminyak', 'vil-lumbung', 'unit-lb-04', 'Direct stay payment, LB-04'),
  tx(33, 5, 'cb-canggu', 'cash_out', 'cat-maint', 14_850_000, 'loc-canggu', 'vil-saka', 'unit-sk-03', 'Pool pump replacement, SK-03', 'submitted'),
  tx(34, 4, 'cb-uluwatu', 'cash_out', 'cat-house', 920_000, 'loc-uluwatu', 'vil-karang', null, 'Amenities restock', 'approved'),
  tx(35, 3, 'bank-bca', 'cash_out', 'cat-mkt', 2_200_000, 'loc-ubud', 'vil-tirta', null, 'Photographer, Villa Tirta listing photos', 'submitted'),
  tx(36, 2, 'cb-ubud', 'cash_out', 'cat-util', 2_710_000, 'loc-ubud', 'vil-tirta', null, 'PLN electricity, Villa Tirta', 'submitted'),
  tx(37, 1, 'cb-canggu', 'cash_in', 'cat-deposit', 2_000_000, 'loc-canggu', 'vil-saka', 'unit-sk-05', 'Security deposit, late arrival BK-2002', 'posted', { bookingId: 'bk-2002' }),
  tx(38, 1, 'cb-seminyak', 'cash_out', 'cat-staff', 600_000, 'loc-seminyak', 'vil-lumbung', null, 'Staff lunch, deep clean day', 'draft'),
  tx(39, 0, 'cb-canggu', 'cash_in', 'cat-room', 5_000_000, 'loc-canggu', 'vil-saka', 'unit-sk-01', 'Direct stay payment, SK-01 arrival today', 'draft'),
  tx(40, 0, 'cb-uluwatu', 'cash_in', 'cat-room', 11_520_000, 'loc-uluwatu', 'vil-karang', 'unit-kr-02', 'Direct stay payment, KR-02'),
]
