import type { AssetStatus, IntervalUnit, MaintenanceCategory, Part, Vendor, WorkOrderPriority, WorkOrderSource, WorkOrderStatus } from '@/domain/maintenance'

export const VENDORS: readonly Vendor[] = [
  { id: 'ven-cooldown', name: 'Cool Down AC Service', trade: 'ac', contact: 'Pak Eka', phone: '+62 812 3800 1122', email: 'service@cooldown.id', rateNote: 'Rp 350.000 per split unit, freon extra', active: true },
  { id: 'ven-poolcare', name: 'Bali Pool Care', trade: 'pool', contact: 'Ketut Arya', phone: '+62 813 3711 4455', email: 'ops@balipoolcare.com', rateNote: 'Monthly contract Rp 1,2 jt per pool', active: true },
  { id: 'ven-sarana', name: 'Sarana Teknik', trade: 'electrical', contact: 'Made Sarana', phone: '+62 811 3900 7788', email: 'sarana.teknik@gmail.com', rateNote: 'Rp 200.000 call-out plus parts', active: true },
  { id: 'ven-pestfree', name: 'Pest Free Bali', trade: 'pest', contact: 'Wayan Sukra', phone: '+62 878 6100 2233', email: 'book@pestfreebali.id', rateNote: 'Fogging Rp 450.000 per villa', active: true },
  { id: 'ven-gatepro', name: 'Gate Pro Motor', trade: 'electrical', contact: 'Andi', phone: '+62 821 4400 9911', email: 'gatepro@balimail.id', rateNote: 'Service Rp 600.000, motor board Rp 1,3 jt', active: true },
  { id: 'ven-bangun', name: 'Tukang Bangun Jaya', trade: 'structure', contact: 'Nyoman Jaya', phone: '+62 817 3300 5566', email: 'bangunjaya@balimail.id', rateNote: 'Day rate Rp 250.000 per worker', active: true },
]

export interface AssetSeed {
  id: string
  code: string
  name: string
  category: MaintenanceCategory
  villaId: string
  unitCode: string | null
  brand: string
  model: string
  serial: string
  boughtDaysAgo: number
  purchaseCost: number
  /** Days of warranty from purchase; null when none. */
  warrantyDays: number | null
  status: AssetStatus
  notes: string
}

const VILLA_OF: Record<string, string> = { SK: 'vil-saka', TR: 'vil-tirta', LB: 'vil-lumbung', KR: 'vil-karang', PD: 'vil-pandawa' }
const UNIT_CODES = ['SK-01', 'SK-02', 'SK-03', 'SK-04', 'SK-05', 'SK-06', 'SK-07', 'SK-08', 'TR-01', 'TR-02', 'TR-03', 'TR-04', 'LB-01', 'LB-02', 'LB-03', 'LB-04', 'KR-01', 'KR-02', 'KR-03', 'PD-01']

/** One split AC per unit, bought in two batches. */
const acUnits: AssetSeed[] = UNIT_CODES.map((code, i) => ({
  id: `ast-${code.toLowerCase()}-ac`,
  code: `${code}-AC`,
  name: `Split AC ${code}`,
  category: 'ac',
  villaId: VILLA_OF[code.slice(0, 2)] ?? 'vil-saka',
  unitCode: code,
  brand: i % 3 === 0 ? 'Daikin' : 'Panasonic',
  model: i % 3 === 0 ? 'FTKC25' : 'CS-PU9',
  serial: `AC${String(240_031 + i * 17)}`,
  boughtDaysAgo: i < 12 ? 900 : 420,
  purchaseCost: i % 3 === 0 ? 5_200_000 : 4_600_000,
  warrantyDays: 730,
  status: 'in_service',
  notes: '',
}))

export const ASSETS: readonly AssetSeed[] = [
  ...acUnits,
  { id: 'ast-sk-03-pump', code: 'SK-03-PUMP', name: 'Private pool pump SK-03', category: 'pool', villaId: 'vil-saka', unitCode: 'SK-03', brand: 'Hayward', model: 'Super Pump 1HP', serial: 'HW77120', boughtDaysAgo: 1500, purchaseCost: 7_800_000, warrantyDays: 365, status: 'under_repair', notes: 'Bearing noise since September; replacement quoted.' },
  { id: 'ast-sk-genset', code: 'SK-GENSET', name: 'Standby generator', category: 'electrical', villaId: 'vil-saka', unitCode: null, brand: 'Yanmar', model: 'YDG5500', serial: 'YN55-0912', boughtDaysAgo: 1200, purchaseCost: 18_500_000, warrantyDays: null, status: 'in_service', notes: 'Covers lights, pumps and the reception during PLN cuts.' },
  { id: 'ast-lb-pump', code: 'LB-POOL-PUMP', name: 'Lap pool pump', category: 'pool', villaId: 'vil-lumbung', unitCode: null, brand: 'Pentair', model: 'SuperFlo VS', serial: 'PF-88341', boughtDaysAgo: 600, purchaseCost: 12_400_000, warrantyDays: 730, status: 'in_service', notes: '' },
  { id: 'ast-tr-01-heater', code: 'TR-01-HEATER', name: 'Water heater TR-01', category: 'plumbing', villaId: 'vil-tirta', unitCode: 'TR-01', brand: 'Ariston', model: 'AN2 30L', serial: 'AR30-5521', boughtDaysAgo: 700, purchaseCost: 2_900_000, warrantyDays: 730, status: 'in_service', notes: '' },
  { id: 'ast-tr-02-heater', code: 'TR-02-HEATER', name: 'Water heater TR-02', category: 'plumbing', villaId: 'vil-tirta', unitCode: 'TR-02', brand: 'Ariston', model: 'AN2 30L', serial: 'AR30-5522', boughtDaysAgo: 700, purchaseCost: 2_900_000, warrantyDays: 730, status: 'under_repair', notes: '' },
  { id: 'ast-kr-gate', code: 'KR-GATE', name: 'Gate motor', category: 'electrical', villaId: 'vil-karang', unitCode: null, brand: 'BFT', model: 'Deimos 600', serial: 'BFT-60-7781', boughtDaysAgo: 1100, purchaseCost: 9_600_000, warrantyDays: null, status: 'in_service', notes: 'Control board replaced in October.' },
]

export interface PlanSeed {
  id: string
  title: string
  category: MaintenanceCategory
  villaId: string
  unitCode: string | null
  assetId: string | null
  every: number
  unit: IntervalUnit
  /** Days from today; negative is overdue. */
  dueOffset: number
  lastDoneDaysAgo: number | null
  checklist: readonly string[]
  assigneeId: string | null
  vendorId: string | null
  estimatedCost: number
}

export const PLANS: readonly PlanSeed[] = [
  { id: 'plan-ac-saka', title: 'AC service, Villa Saka', category: 'ac', villaId: 'vil-saka', unitCode: null, assetId: null, every: 3, unit: 'months', dueOffset: 5, lastDoneDaysAgo: 87, checklist: ['Clean filters and coils', 'Check freon pressure', 'Flush the drain line'], assigneeId: null, vendorId: 'ven-cooldown', estimatedCost: 2_800_000 },
  { id: 'plan-ac-karang', title: 'AC service, Villa Karang', category: 'ac', villaId: 'vil-karang', unitCode: null, assetId: null, every: 3, unit: 'months', dueOffset: -3, lastDoneDaysAgo: 95, checklist: ['Clean filters and coils', 'Check freon pressure', 'Flush the drain line'], assigneeId: null, vendorId: 'ven-cooldown', estimatedCost: 1_050_000 },
  { id: 'plan-pump-saka', title: 'Pool pump check, Saka units', category: 'pool', villaId: 'vil-saka', unitCode: null, assetId: null, every: 1, unit: 'months', dueOffset: 12, lastDoneDaysAgo: 17, checklist: ['Listen for bearing noise', 'Clean the strainer basket', 'Check pressure gauge'], assigneeId: 'emp-004', vendorId: null, estimatedCost: 150_000 },
  { id: 'plan-pump-lumbung', title: 'Lap pool check, Villa Lumbung', category: 'pool', villaId: 'vil-lumbung', unitCode: null, assetId: 'ast-lb-pump', every: 1, unit: 'months', dueOffset: 2, lastDoneDaysAgo: 28, checklist: ['Test chlorine and pH', 'Backwash the filter', 'Check pump seals'], assigneeId: null, vendorId: 'ven-poolcare', estimatedCost: 1_200_000 },
  { id: 'plan-fog-tirta', title: 'Fogging, Villa Tirta', category: 'pest', villaId: 'vil-tirta', unitCode: null, assetId: null, every: 1, unit: 'months', dueOffset: -1, lastDoneDaysAgo: 31, checklist: ['Garden and drains', 'Under the decks', 'Staff area'], assigneeId: null, vendorId: 'ven-pestfree', estimatedCost: 450_000 },
  { id: 'plan-fog-saka', title: 'Fogging, Villa Saka', category: 'pest', villaId: 'vil-saka', unitCode: null, assetId: null, every: 1, unit: 'months', dueOffset: 20, lastDoneDaysAgo: 10, checklist: ['Garden and drains', 'Shared pool area', 'Staff area'], assigneeId: null, vendorId: 'ven-pestfree', estimatedCost: 450_000 },
  { id: 'plan-genset-saka', title: 'Generator service', category: 'electrical', villaId: 'vil-saka', unitCode: null, assetId: 'ast-sk-genset', every: 6, unit: 'months', dueOffset: 40, lastDoneDaysAgo: 140, checklist: ['Change oil and filter', 'Load test 30 minutes', 'Check battery'], assigneeId: null, vendorId: 'ven-sarana', estimatedCost: 1_400_000 },
  { id: 'plan-gate-karang', title: 'Gate motor service', category: 'electrical', villaId: 'vil-karang', unitCode: null, assetId: 'ast-kr-gate', every: 6, unit: 'months', dueOffset: 60, lastDoneDaysAgo: 14, checklist: ['Grease the rail', 'Test the safety sensor', 'Check remote batteries'], assigneeId: null, vendorId: 'ven-gatepro', estimatedCost: 600_000 },
]

export interface WorkOrderSeed {
  seq: number
  villaId: string
  unitCode: string | null
  assetId: string | null
  planId: string | null
  source: WorkOrderSource
  category: MaintenanceCategory
  priority: WorkOrderPriority
  title: string
  description: string
  reportedBy: string
  assigneeId: string | null
  vendorId: string | null
  status: WorkOrderStatus
  createdDaysAgo: number
  /** Offsets from today; null when the step did not happen. */
  scheduledOffset: number | null
  startedOffset: number | null
  finishedOffset: number | null
  verifiedOffset: number | null
  parts: readonly Part[]
  labourCost: number
  vendorCost: number
  blockId: string | null
  transactionSeq: number | null
  beforePhotos: readonly string[]
  afterPhotos: readonly string[]
  note: string
}

const wo = (seq: number, w: Partial<WorkOrderSeed> & Pick<WorkOrderSeed, 'villaId' | 'category' | 'title' | 'status' | 'createdDaysAgo'>): WorkOrderSeed => ({
  seq,
  unitCode: null,
  assetId: null,
  planId: null,
  source: 'manual',
  priority: 'normal',
  description: '',
  reportedBy: 'Kadek Ariani',
  assigneeId: null,
  vendorId: null,
  scheduledOffset: null,
  startedOffset: null,
  finishedOffset: null,
  verifiedOffset: null,
  parts: [],
  labourCost: 0,
  vendorCost: 0,
  blockId: null,
  transactionSeq: null,
  beforePhotos: [],
  afterPhotos: [],
  note: '',
  ...w,
})

/** Two months of jobs in every status, tied to the cash entries and the SK-03 block already in the seed. */
export const WORK_ORDERS: readonly WorkOrderSeed[] = [
  wo(1, { villaId: 'vil-saka', unitCode: 'SK-03', assetId: 'ast-sk-03-pump', category: 'pool', priority: 'urgent', title: 'Replace the pool pump in SK-03', description: 'Bearing grinding, pump trips the breaker twice a day. Guests moved to SK-05.', reportedBy: 'Wayan Sudiarta', vendorId: 'ven-poolcare', status: 'in_progress', createdDaysAgo: 6, scheduledOffset: 1, startedOffset: -1, vendorCost: 14_850_000, blockId: 'blk-1', transactionSeq: 33, beforePhotos: ['sk03-pump-room.jpg', 'sk03-breaker.jpg'], note: 'Quote QUO-0917-SK03 approved by the villa manager, waiting for finance.' }),
  wo(2, { villaId: 'vil-karang', unitCode: 'KR-02', assetId: 'ast-kr-02-ac', category: 'ac', title: 'AC service KR-02, weak cooling', description: 'Guest complained the bedroom stays at 27 degrees.', reportedBy: 'Dewa Agung Putra', vendorId: 'ven-cooldown', status: 'verified', createdDaysAgo: 40, scheduledOffset: -39, startedOffset: -38, finishedOffset: -38, verifiedOffset: -37, vendorCost: 2_750_000, transactionSeq: 5, afterPhotos: ['kr02-ac-after.jpg'] }),
  wo(3, { villaId: 'vil-karang', unitCode: 'KR-03', assetId: 'ast-kr-gate', category: 'electrical', priority: 'high', title: 'Gate motor does not close', description: 'Gate stops halfway; guests cannot leave by car.', reportedBy: 'Dewa Agung Putra', vendorId: 'ven-gatepro', status: 'verified', createdDaysAgo: 15, startedOffset: -14, finishedOffset: -14, verifiedOffset: -13, vendorCost: 1_900_000, transactionSeq: 24 }),
  wo(4, { villaId: 'vil-lumbung', unitCode: 'LB-02', category: 'plumbing', priority: 'high', title: 'Leaking shower mixer LB-02', description: 'Water on the bathroom floor after every shower.', reportedBy: 'Luh Ayu Lestari', assigneeId: 'emp-004', status: 'done', createdDaysAgo: 20, startedOffset: -19, finishedOffset: -19, parts: [{ name: 'Shower mixer cartridge', qty: 1, unitCost: 385_000 }, { name: 'Silicone sealant', qty: 2, unitCost: 45_000 }], labourCost: 150_000, beforePhotos: ['lb02-leak.jpg'], afterPhotos: ['lb02-fixed.jpg'] }),
  wo(5, { villaId: 'vil-tirta', unitCode: 'TR-02', assetId: 'ast-tr-02-heater', category: 'plumbing', priority: 'urgent', title: 'No hot water in TR-02', description: 'Heater light is off; breaker is fine.', reportedBy: 'Komang Dewi', status: 'open', createdDaysAgo: 0 }),
  wo(6, { villaId: 'vil-saka', unitCode: 'SK-06', assetId: 'ast-sk-06-ac', category: 'ac', title: 'Noisy AC indoor unit SK-06', description: 'Rattle at high fan speed.', reportedBy: 'Ni Luh Putu Sari', vendorId: 'ven-cooldown', status: 'scheduled', createdDaysAgo: 3, scheduledOffset: 2 }),
  wo(7, { villaId: 'vil-lumbung', unitCode: 'LB-04', category: 'electrical', priority: 'low', title: 'Reading lamp flickers LB-04', reportedBy: 'Luh Ayu Lestari', status: 'cancelled', createdDaysAgo: 12, note: 'Loose bulb; housekeeping fixed it on the spot.' }),
  wo(8, { villaId: 'vil-tirta', unitCode: 'TR-04', category: 'structure', title: 'Ceiling stain after the rain TR-04', description: 'Brown ring above the bed, about 40 cm.', reportedBy: 'Putu Eka Wijaya', vendorId: 'ven-bangun', status: 'on_hold', createdDaysAgo: 10, scheduledOffset: -6, startedOffset: -6, note: 'Waiting for the roofer to replace three tiles once the rain stops.' }),
  wo(9, { villaId: 'vil-karang', unitCode: 'KR-01', category: 'garden', priority: 'low', title: 'Irrigation timer KR-01 garden', reportedBy: 'Dewa Agung Putra', assigneeId: 'emp-012', status: 'verified', createdDaysAgo: 25, startedOffset: -24, finishedOffset: -24, verifiedOffset: -22, parts: [{ name: 'Irrigation timer', qty: 1, unitCost: 320_000 }] }),
  wo(10, { villaId: 'vil-saka', unitCode: 'SK-01', category: 'electrical', title: 'Door lock battery SK-01', reportedBy: 'Wayan Sudiarta', assigneeId: 'emp-004', status: 'verified', createdDaysAgo: 30, startedOffset: -30, finishedOffset: -30, verifiedOffset: -29, parts: [{ name: 'AA lithium batteries', qty: 4, unitCost: 35_000 }] }),
  wo(11, { villaId: 'vil-karang', unitCode: null, planId: 'plan-ac-karang', source: 'preventive', category: 'ac', title: 'AC service, Villa Karang', description: 'Clean filters and coils · Check freon pressure · Flush the drain line', reportedBy: 'Preventive plan', vendorId: 'ven-cooldown', status: 'open', createdDaysAgo: 4, scheduledOffset: -3 }),
  wo(12, { villaId: 'vil-tirta', unitCode: null, planId: 'plan-fog-tirta', source: 'preventive', category: 'pest', title: 'Fogging, Villa Tirta', reportedBy: 'Preventive plan', vendorId: 'ven-pestfree', status: 'verified', createdDaysAgo: 33, scheduledOffset: -31, startedOffset: -31, finishedOffset: -31, verifiedOffset: -30, vendorCost: 450_000 }),
  wo(13, { villaId: 'vil-saka', unitCode: null, planId: 'plan-pump-saka', source: 'preventive', category: 'pool', title: 'Pool pump check, Saka units', reportedBy: 'Preventive plan', assigneeId: 'emp-004', status: 'verified', createdDaysAgo: 19, scheduledOffset: -18, startedOffset: -17, finishedOffset: -17, verifiedOffset: -16, labourCost: 150_000, note: 'Found the SK-03 bearing noise.' }),
  wo(14, { villaId: 'vil-lumbung', unitCode: 'LB-01', category: 'appliance', priority: 'high', title: 'Minibar fridge not cooling LB-01', reportedBy: 'Luh Ayu Lestari', assigneeId: 'emp-004', status: 'in_progress', createdDaysAgo: 2, startedOffset: -1, parts: [{ name: 'Fridge thermostat', qty: 1, unitCost: 175_000 }] }),
  wo(15, { villaId: 'vil-saka', unitCode: 'SK-08', category: 'structure', title: 'Cracked bathroom tiles SK-08', description: 'Found on inspection after check-out; two tiles by the shower.', reportedBy: 'Ni Luh Putu Sari', source: 'inspection', status: 'open', createdDaysAgo: 2 }),
  wo(16, { villaId: 'vil-karang', unitCode: 'KR-02', category: 'appliance', priority: 'low', title: 'Smart TV remote lost KR-02', reportedBy: 'Dewa Agung Putra', assigneeId: 'emp-011', status: 'done', createdDaysAgo: 6, finishedOffset: -5, parts: [{ name: 'Universal remote', qty: 1, unitCost: 250_000 }] }),
  wo(17, { villaId: 'vil-pandawa', unitCode: 'PD-01', category: 'structure', title: 'Renovation: rewire and repaint PD-01', description: 'Closed until December; rewiring the kitchen and two bedrooms.', reportedBy: 'Rama Wijaya', vendorId: 'ven-bangun', status: 'in_progress', createdDaysAgo: 45, scheduledOffset: -42, startedOffset: -40, vendorCost: 0, note: 'Invoice comes at handover.' }),
  wo(18, { villaId: 'vil-saka', unitCode: null, assetId: 'ast-sk-genset', category: 'electrical', priority: 'high', title: 'Generator failed to start during PLN cut', reportedBy: 'Ketut Suardana', vendorId: 'ven-sarana', status: 'verified', createdDaysAgo: 52, startedOffset: -51, finishedOffset: -51, verifiedOffset: -50, parts: [{ name: 'Starter battery 12V', qty: 1, unitCost: 1_150_000 }], vendorCost: 200_000 }),
]

/** Today's board for the units the departure and arrival plans do not decide. */
export const HOUSEKEEPING_NOTES: Record<string, string> = {
  dirty: 'Checked out, waiting for housekeeping',
  cleaning: 'Housekeeping in the room',
  inspected: 'Clean, waiting for release',
}
