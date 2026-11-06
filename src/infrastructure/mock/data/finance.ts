import type { AccountKind, Category, TransactionKind, TransactionOrigin, TransactionStatus } from '@/domain/finance'

export interface AccountSeed {
  id: string
  name: string
  kind: AccountKind
  locationId: string | null
  villaId: string | null
  floatLimit: number | null
  custodianId: string | null
  openingBalance: number
  openedDaysAgo: number
}

const box = (id: string, name: string, kind: AccountKind, locationId: string | null, openingBalance: number): AccountSeed => ({ id, name, kind, locationId, villaId: null, floatLimit: null, custodianId: null, openingBalance, openedDaysAgo: 60 })
/** Petty cash opens full: the float is the opening balance. */
const petty = (villa: string, name: string, locationId: string, floatLimit: number, custodianId: string): AccountSeed => ({ id: `pc-${villa}`, name: `${name} petty cash`, kind: 'petty', locationId, villaId: `vil-${villa}`, floatLimit, custodianId, openingBalance: floatLimit, openedDaysAgo: 60 })

export const ACCOUNTS: readonly AccountSeed[] = [
  box('cb-canggu', 'Canggu cashbox', 'cashbox', 'loc-canggu', 12_500_000),
  box('cb-ubud', 'Ubud cashbox', 'cashbox', 'loc-ubud', 8_000_000),
  box('cb-seminyak', 'Seminyak cashbox', 'cashbox', 'loc-seminyak', 9_000_000),
  box('cb-uluwatu', 'Uluwatu cashbox', 'cashbox', 'loc-uluwatu', 6_000_000),
  box('bank-bca', 'BCA operating account', 'bank', null, 145_000_000),
  petty('saka', 'Villa Saka', 'loc-canggu', 3_000_000, 'emp-002'),
  petty('tirta', 'Villa Tirta', 'loc-ubud', 2_500_000, 'emp-007'),
  petty('lumbung', 'Villa Lumbung', 'loc-seminyak', 2_500_000, 'emp-010'),
  petty('karang', 'Villa Karang', 'loc-uluwatu', 2_000_000, 'emp-012'),
  petty('pandawa', 'Villa Pandawa', 'loc-uluwatu', 1_000_000, 'emp-011'),
]

const cat = (id: string, name: string, kind: TransactionKind, slot: number, extra: Partial<Category> = {}): Category => ({ id, name, kind, slot, active: true, villaIds: [], ...extra })

/** Income and expense lines; the system ones (transfer, adjustment, payroll) stay fixed. */
export const CATEGORIES: readonly Category[] = [
  cat('cat-room', 'Room revenue', 'cash_in', 1),
  cat('cat-airbnb', 'Airbnb payout', 'cash_in', 2),
  cat('cat-extra', 'Extra services', 'cash_in', 3),
  cat('cat-deposit', 'Security deposit', 'cash_in', 4),
  cat('cat-transfer-in', 'Transfer in', 'cash_in', 0),
  cat('cat-adjust-in', 'Balance adjustment', 'cash_in', 0),
  cat('cat-util', 'Utilities', 'cash_out', 1),
  cat('cat-house', 'Housekeeping supplies', 'cash_out', 2),
  cat('cat-maint', 'Maintenance', 'cash_out', 3),
  cat('cat-staff', 'Staff and transport', 'cash_out', 4),
  cat('cat-mkt', 'Marketing', 'cash_out', 5),
  cat('cat-payroll', 'Salaries and payroll', 'cash_out', 0),
  cat('cat-other', 'Other', 'cash_out', 0),
  cat('cat-transfer-out', 'Transfer out', 'cash_out', 0),
  cat('cat-adjust-out', 'Balance adjustment', 'cash_out', 0),
  cat('cat-fees', 'Payment fees', 'cash_out', 0),
  cat('cat-pool', 'Pool chemicals', 'cash_out', 0, { active: false }),
  cat('cat-boat', 'Boat and dive trips', 'cash_out', 0, { villaIds: ['vil-karang', 'vil-pandawa'] }),
  cat('cat-svc-fnb', 'Room service food and drinks', 'cash_in', 0),
  cat('cat-svc-laundry', 'Laundry service', 'cash_in', 0),
  cat('cat-svc-transport', 'Transport service', 'cash_in', 0),
  cat('cat-svc-spa', 'Spa service', 'cash_in', 0),
  cat('cat-svc-tours', 'Tours and activities', 'cash_in', 0),
  cat('cat-svc-other', 'Other guest services', 'cash_in', 0),
  cat('cat-svc-partner', 'Service partner costs', 'cash_out', 0),
  cat('cat-minibar', 'Minibar stock', 'cash_out', 0),
  cat('cat-bpjs', 'BPJS remittance', 'cash_out', 0),
  cat('cat-pph21', 'PPh 21 remittance', 'cash_out', 0),
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
  reference?: string
  attachments?: readonly string[]
  origin?: TransactionOrigin
  /** Both halves of a transfer share the sequence of the cash-out half. */
  transferSeq?: number
  rejectionReason?: string
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
  extra: Partial<Pick<TransactionSeed, 'bookingId' | 'reversalOfSeq' | 'reference' | 'attachments' | 'origin' | 'transferSeq' | 'rejectionReason'>> = {},
): TransactionSeed => ({ seq, daysAgo, accountId, kind, categoryId, amount, locationId, villaId, unitId, bookingId: null, description, status, ...extra })

/** Six weeks of money through the cashboxes and the bank, oldest first. */
export const TRANSACTIONS: readonly TransactionSeed[] = [
  tx(1, 44, 'bank-bca', 'cash_in', 'cat-airbnb', 31_250_000, 'loc-canggu', 'vil-saka', null, 'Airbnb payout, Saka Stays, August second half'),
  tx(2, 43, 'cb-canggu', 'cash_out', 'cat-util', 4_180_000, 'loc-canggu', 'vil-saka', null, 'PLN electricity, Villa Saka', 'posted', { reference: 'PLN-5171-0826', attachments: ['pln-august.pdf'] }),
  tx(3, 41, 'cb-ubud', 'cash_in', 'cat-room', 7_920_000, 'loc-ubud', 'vil-tirta', 'unit-tr-03', 'Direct stay payment, TR-03'),
  tx(4, 40, 'cb-seminyak', 'cash_out', 'cat-house', 1_350_000, 'loc-seminyak', 'vil-lumbung', null, 'Linen and amenities restock'),
  tx(5, 38, 'cb-uluwatu', 'cash_out', 'cat-maint', 2_750_000, 'loc-uluwatu', 'vil-karang', 'unit-kr-02', 'AC service, KR-02', 'posted', { reference: 'INV/CD/0812', attachments: ['cooldown-invoice-0812.jpg'] }),
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
  tx(19, 20, 'bank-bca', 'cash_out', 'cat-payroll', 24_000_000, 'loc-canggu', null, null, 'September salaries, all villas', 'posted', { origin: 'payroll', reference: 'PAY-2026-09' }),
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
  tx(33, 5, 'cb-canggu', 'cash_out', 'cat-maint', 14_850_000, 'loc-canggu', 'vil-saka', 'unit-sk-03', 'Pool pump replacement, SK-03', 'submitted', { reference: 'QUO-0917-SK03', attachments: ['quote-pool-pump.pdf', 'photo-pump-room.jpg'] }),
  tx(34, 4, 'cb-uluwatu', 'cash_out', 'cat-house', 920_000, 'loc-uluwatu', 'vil-karang', null, 'Amenities restock', 'approved'),
  tx(35, 3, 'bank-bca', 'cash_out', 'cat-mkt', 2_200_000, 'loc-ubud', 'vil-tirta', null, 'Photographer, Villa Tirta listing photos', 'submitted'),
  tx(36, 2, 'cb-ubud', 'cash_out', 'cat-util', 2_710_000, 'loc-ubud', 'vil-tirta', null, 'PLN electricity, Villa Tirta', 'submitted'),
  tx(37, 1, 'cb-canggu', 'cash_in', 'cat-deposit', 2_000_000, 'loc-canggu', 'vil-saka', 'unit-sk-05', 'Security deposit, late arrival BK-2002', 'posted', { bookingId: 'bk-2002' }),
  tx(38, 1, 'cb-seminyak', 'cash_out', 'cat-staff', 600_000, 'loc-seminyak', 'vil-lumbung', null, 'Staff lunch, deep clean day', 'draft'),
  tx(39, 0, 'cb-canggu', 'cash_in', 'cat-room', 5_000_000, 'loc-canggu', 'vil-saka', 'unit-sk-01', 'Direct stay payment, SK-01 arrival today', 'draft'),
  tx(40, 0, 'cb-uluwatu', 'cash_in', 'cat-room', 11_520_000, 'loc-uluwatu', 'vil-karang', 'unit-kr-02', 'Direct stay payment, KR-02'),
  tx(41, 6, 'cb-seminyak', 'cash_out', 'cat-other', 1_800_000, 'loc-seminyak', 'vil-lumbung', null, 'Team dinner after the deep clean', 'rejected', { rejectionReason: 'Book it as staff welfare in the monthly budget, not from the cashbox.' }),
  tx(42, 9, 'bank-bca', 'cash_out', 'cat-transfer-out', 10_000_000, 'loc-canggu', null, null, 'Top up the Canggu cashbox', 'posted', { origin: 'transfer', transferSeq: 42, reference: 'TRF-0926' }),
  tx(43, 9, 'cb-canggu', 'cash_in', 'cat-transfer-in', 10_000_000, 'loc-canggu', null, null, 'Top up the Canggu cashbox', 'posted', { origin: 'transfer', transferSeq: 42, reference: 'TRF-0926' }),
  tx(44, 3, 'cb-uluwatu', 'cash_out', 'cat-adjust-out', 150_000, 'loc-uluwatu', null, null, 'Cash count short by Rp 150.000; receipt for the gate padlock missing', 'posted', { origin: 'reconciliation' }),
  tx(45, 50, 'bank-bca', 'cash_out', 'cat-payroll', 23_600_000, 'loc-canggu', null, null, 'August salaries, all villas', 'posted', { origin: 'payroll', reference: 'PAY-2026-08' }),
  // Petty cash: small spends at each villa, one top-up from the Seminyak cashbox, Karang running low.
  tx(46, 20, 'pc-saka', 'cash_out', 'cat-house', 350_000, 'loc-canggu', 'vil-saka', null, 'Gas refill and dish soap'),
  tx(47, 12, 'pc-saka', 'cash_out', 'cat-staff', 240_000, 'loc-canggu', 'vil-saka', null, 'Ojek for the laundry run'),
  tx(48, 6, 'pc-saka', 'cash_out', 'cat-maint', 480_000, 'loc-canggu', 'vil-saka', 'unit-sk-02', 'Light bulbs and fuses, SK-02', 'posted', { attachments: ['receipt-bulbs.jpg'] }),
  tx(49, 2, 'pc-saka', 'cash_out', 'cat-other', 150_000, 'loc-canggu', 'vil-saka', null, 'Canang and temple offerings'),
  tx(50, 15, 'pc-tirta', 'cash_out', 'cat-house', 620_000, 'loc-ubud', 'vil-tirta', null, 'Mosquito coils and repellent'),
  tx(51, 4, 'pc-tirta', 'cash_out', 'cat-staff', 300_000, 'loc-ubud', 'vil-tirta', null, 'Driver parking and tolls', 'submitted'),
  tx(52, 18, 'pc-lumbung', 'cash_out', 'cat-house', 900_000, 'loc-seminyak', 'vil-lumbung', null, 'Pool test strips and skimmer net'),
  tx(53, 9, 'pc-lumbung', 'cash_out', 'cat-maint', 650_000, 'loc-seminyak', 'vil-lumbung', 'unit-lb-03', 'Shower head, LB-03', 'posted', { attachments: ['receipt-shower-head.jpg'] }),
  tx(54, 3, 'pc-lumbung', 'cash_out', 'cat-house', 400_000, 'loc-seminyak', 'vil-lumbung', null, 'Drinking water gallons'),
  tx(55, 2, 'cb-seminyak', 'cash_out', 'cat-transfer-out', 1_500_000, 'loc-seminyak', 'vil-lumbung', null, 'Top up Villa Lumbung petty cash', 'posted', { origin: 'transfer', transferSeq: 55, reference: 'PC-LB-01' }),
  tx(56, 2, 'pc-lumbung', 'cash_in', 'cat-transfer-in', 1_500_000, 'loc-seminyak', 'vil-lumbung', null, 'Top up Villa Lumbung petty cash', 'posted', { origin: 'transfer', transferSeq: 55, reference: 'PC-LB-01' }),
  tx(57, 14, 'pc-karang', 'cash_out', 'cat-maint', 700_000, 'loc-uluwatu', 'vil-karang', null, 'Padlocks and chain for the gate'),
  tx(58, 8, 'pc-karang', 'cash_out', 'cat-house', 520_000, 'loc-uluwatu', 'vil-karang', null, 'Pool chlorine tablets'),
  tx(59, 1, 'pc-karang', 'cash_out', 'cat-staff', 380_000, 'loc-uluwatu', 'vil-karang', null, 'Night guard meals'),
]

export interface ReconciliationSeed {
  id: string
  accountId: string
  daysAgo: number
  counted: number
  /** Difference against the book balance that day; zero when the count matched. */
  difference: number
  note: string
  by: string
  adjustmentSeq: number | null
}

export const RECONCILIATIONS: readonly ReconciliationSeed[] = [
  { id: 'rec-1', accountId: 'cb-canggu', daysAgo: 7, counted: 0, difference: 0, note: 'Weekly count with Wayan; matched to the rupiah.', by: 'Kadek Ariani', adjustmentSeq: null },
  { id: 'rec-2', accountId: 'cb-uluwatu', daysAgo: 3, counted: 0, difference: -150_000, note: 'Short; Dewa to find the padlock receipt.', by: 'Ida Bagus Rai', adjustmentSeq: 44 },
  { id: 'rec-3', accountId: 'pc-saka', daysAgo: 5, counted: 0, difference: 0, note: 'Weekly petty cash count with Wayan.', by: 'Kadek Ariani', adjustmentSeq: null },
]
