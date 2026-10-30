import type { Allowance, Department, EmployeeStatus, LeaveKind, LoanKind, LoanStatus, RequestStatus, Shift, VillaAllocation } from '@/domain/hr'

export interface EmployeeSeed {
  id: string
  code: string
  name: string
  position: string
  department: Department
  status: EmployeeStatus
  joinedDaysAgo: number
  leftDaysAgo: number | null
  phone: string
  email: string
  bankName: string
  bankAccount: string
  npwp: string
  allocations: readonly VillaAllocation[]
  basicSalary: number
  allowances: readonly Allowance[]
  serviceChargeEligible: boolean
  bpjsEnrolled: boolean
  annualLeaveDays: number
  /** Weekday index (Monday 0) the roster gives as the day off. */
  dayOff: number
  shiftId: string
}

const MEAL: Allowance = { name: 'Meal', amount: 600_000 }
const TRANSPORT: Allowance = { name: 'Transport', amount: 400_000 }
const POSITION: Allowance = { name: 'Position', amount: 1_500_000 }

const emp = (
  n: number,
  name: string,
  position: string,
  department: Department,
  allocations: readonly VillaAllocation[],
  basicSalary: number,
  joinedDaysAgo: number,
  extra: Partial<EmployeeSeed> = {},
): EmployeeSeed => ({
  id: `emp-${String(n).padStart(3, '0')}`,
  code: `EMP-${String(n).padStart(3, '0')}`,
  name,
  position,
  department,
  status: 'active',
  joinedDaysAgo,
  leftDaysAgo: null,
  phone: `+62 81${String(2000 + n * 37).slice(-3)} ${String(1000 + n * 113).slice(-4)} ${String(5000 + n * 71).slice(-4)}`,
  email: `${name.toLowerCase().split(' ')[0]}@balivillas.id`,
  bankName: n % 3 === 0 ? 'Mandiri' : 'BCA',
  bankAccount: String(1_400_000_000 + n * 7_654_321),
  npwp: n % 4 === 0 ? '' : `${String(10 + n).padStart(2, '0')}.${String(345 + n * 11)}.${String(678 + n * 3)}.${n}-901.000`,
  allocations,
  basicSalary,
  allowances: [MEAL, TRANSPORT],
  serviceChargeEligible: true,
  bpjsEnrolled: true,
  annualLeaveDays: 12,
  dayOff: n % 6,
  shiftId: 'sh-morning',
  ...extra,
})

const one = (villaId: string): VillaAllocation[] => [{ villaId, percent: 100 }]

/** Fifteen people across the villas; EMP-001 is the signed-in manager, EMP-015 has left. */
export const EMPLOYEES: readonly EmployeeSeed[] = [
  emp(1, 'Kadek Ariani', 'Villa manager, Canggu', 'management', [{ villaId: 'vil-saka', percent: 70 }, { villaId: 'vil-lumbung', percent: 30 }], 7_500_000, 1_120, { allowances: [MEAL, TRANSPORT, POSITION], serviceChargeEligible: false }),
  emp(2, 'Wayan Sudiarta', 'Front desk', 'front_desk', one('vil-saka'), 4_200_000, 820, { shiftId: 'sh-afternoon' }),
  emp(3, 'Ni Luh Putu Sari', 'Housekeeping', 'housekeeping', one('vil-saka'), 3_600_000, 640),
  emp(4, 'Made Wirawan', 'Maintenance technician', 'maintenance', [{ villaId: 'vil-saka', percent: 50 }, { villaId: 'vil-lumbung', percent: 50 }], 4_000_000, 1_400),
  emp(5, 'Ketut Suardana', 'Night security', 'security', one('vil-saka'), 3_500_000, 980, { shiftId: 'sh-night', npwp: '' }),
  emp(6, 'Komang Dewi', 'Front desk', 'front_desk', one('vil-tirta'), 4_200_000, 560),
  emp(7, 'Gede Arta', 'Housekeeping', 'housekeeping', one('vil-tirta'), 3_600_000, 450, { shiftId: 'sh-afternoon' }),
  emp(8, 'Putu Eka Wijaya', 'Villa manager, Ubud', 'management', one('vil-tirta'), 7_000_000, 1_300, { allowances: [MEAL, TRANSPORT, POSITION], serviceChargeEligible: false }),
  emp(9, 'Luh Ayu Lestari', 'Housekeeping', 'housekeeping', one('vil-lumbung'), 3_600_000, 300),
  emp(10, 'Nyoman Suta', 'Security', 'security', one('vil-lumbung'), 3_500_000, 760, { shiftId: 'sh-night' }),
  emp(11, 'Dewa Agung Putra', 'Front desk', 'front_desk', one('vil-karang'), 4_400_000, 690),
  emp(12, 'Kadek Yuliani', 'Housekeeping', 'housekeeping', [{ villaId: 'vil-karang', percent: 60 }, { villaId: 'vil-pandawa', percent: 40 }], 3_800_000, 410),
  emp(13, 'Ida Bagus Rai', 'Finance and admin', 'finance', [{ villaId: 'vil-saka', percent: 25 }, { villaId: 'vil-tirta', percent: 25 }, { villaId: 'vil-lumbung', percent: 25 }, { villaId: 'vil-karang', percent: 25 }], 6_500_000, 900, { allowances: [MEAL, TRANSPORT, POSITION], serviceChargeEligible: false }),
  emp(14, 'Sri Wahyuni', 'Cook', 'fnb', one('vil-tirta'), 3_400_000, 45, { status: 'probation', bpjsEnrolled: false, npwp: '' }),
  emp(15, 'Agus Pratama', 'Maintenance technician', 'maintenance', one('vil-karang'), 3_900_000, 1_000, { status: 'inactive', leftDaysAgo: 60 }),
]

export const SHIFTS: readonly Shift[] = [
  { id: 'sh-morning', name: 'Morning', start: '07:00', end: '15:00' },
  { id: 'sh-afternoon', name: 'Afternoon', start: '14:00', end: '22:00' },
  { id: 'sh-night', name: 'Night', start: '22:00', end: '06:00' },
]

export interface LeaveSeed {
  seq: number
  employeeId: string
  kind: LeaveKind
  fromOffset: number
  toOffset: number
  reason: string
  status: RequestStatus
  requestedDaysAgo: number
  decidedBy: string
  decisionNote: string
}

export const LEAVES: readonly LeaveSeed[] = [
  { seq: 1, employeeId: 'emp-003', kind: 'annual', fromOffset: -40, toOffset: -36, reason: 'Galungan with family in Karangasem', status: 'approved', requestedDaysAgo: 55, decidedBy: 'Kadek Ariani', decisionNote: 'Covered by Luh Ayu' },
  { seq: 2, employeeId: 'emp-006', kind: 'sick', fromOffset: -18, toOffset: -17, reason: 'Fever, doctor’s note attached', status: 'approved', requestedDaysAgo: 18, decidedBy: 'Putu Eka Wijaya', decisionNote: '' },
  { seq: 3, employeeId: 'emp-011', kind: 'annual', fromOffset: -9, toOffset: -7, reason: 'Wedding in Singaraja', status: 'approved', requestedDaysAgo: 24, decidedBy: 'Nia Kusuma', decisionNote: '' },
  { seq: 4, employeeId: 'emp-002', kind: 'permission', fromOffset: -3, toOffset: -3, reason: 'Banjar meeting, half day', status: 'approved', requestedDaysAgo: 5, decidedBy: 'Kadek Ariani', decisionNote: '' },
  { seq: 5, employeeId: 'emp-009', kind: 'annual', fromOffset: 6, toOffset: 10, reason: 'Trip to Lombok', status: 'pending', requestedDaysAgo: 2, decidedBy: '', decisionNote: '' },
  { seq: 6, employeeId: 'emp-007', kind: 'annual', fromOffset: 12, toOffset: 13, reason: 'Nyepi preparation', status: 'pending', requestedDaysAgo: 1, decidedBy: '', decisionNote: '' },
  { seq: 7, employeeId: 'emp-004', kind: 'unpaid', fromOffset: -30, toOffset: -24, reason: 'Family matter', status: 'rejected', requestedDaysAgo: 34, decidedBy: 'Kadek Ariani', decisionNote: 'Pool pump replacement that week; take annual leave the week after' },
  { seq: 8, employeeId: 'emp-012', kind: 'annual', fromOffset: 20, toOffset: 22, reason: 'Odalan at the family temple', status: 'pending', requestedDaysAgo: 0, decidedBy: '', decisionNote: '' },
]

export interface OvertimeSeed {
  seq: number
  employeeId: string
  dayOffset: number
  hours: number
  villaId: string
  reason: string
  status: RequestStatus
  decidedBy: string
}

export const OVERTIME: readonly OvertimeSeed[] = [
  { seq: 1, employeeId: 'emp-004', dayOffset: -33, hours: 4, villaId: 'vil-saka', reason: 'Pool pump emergency, SK-03', status: 'approved', decidedBy: 'Kadek Ariani' },
  { seq: 2, employeeId: 'emp-002', dayOffset: -27, hours: 3, villaId: 'vil-saka', reason: 'Late arrival BK-1312 at 01:00', status: 'approved', decidedBy: 'Kadek Ariani' },
  { seq: 3, employeeId: 'emp-007', dayOffset: -21, hours: 2.5, villaId: 'vil-tirta', reason: 'Turnover of two suites on one afternoon', status: 'approved', decidedBy: 'Putu Eka Wijaya' },
  { seq: 4, employeeId: 'emp-010', dayOffset: -16, hours: 6, villaId: 'vil-lumbung', reason: 'Double shift, colleague sick', status: 'approved', decidedBy: 'Kadek Ariani' },
  { seq: 5, employeeId: 'emp-012', dayOffset: -11, hours: 3, villaId: 'vil-karang', reason: 'Deep clean KR-02 after check-out', status: 'approved', decidedBy: 'Nia Kusuma' },
  { seq: 6, employeeId: 'emp-004', dayOffset: -6, hours: 5, villaId: 'vil-lumbung', reason: 'Gate motor repair', status: 'approved', decidedBy: 'Kadek Ariani' },
  { seq: 7, employeeId: 'emp-006', dayOffset: -2, hours: 2, villaId: 'vil-tirta', reason: 'Group check-in of four rooms', status: 'pending', decidedBy: '' },
  { seq: 8, employeeId: 'emp-003', dayOffset: -1, hours: 3, villaId: 'vil-saka', reason: 'Linen inventory count', status: 'pending', decidedBy: '' },
  { seq: 9, employeeId: 'emp-005', dayOffset: -14, hours: 4, villaId: 'vil-saka', reason: 'Extra night round, festival weekend', status: 'rejected', decidedBy: 'Kadek Ariani' },
  { seq: 10, employeeId: 'emp-011', dayOffset: 0, hours: 2, villaId: 'vil-karang', reason: 'Late check-out KR-01, waiting for the guest', status: 'pending', decidedBy: '' },
]

export interface LoanSeed {
  seq: number
  employeeId: string
  kind: LoanKind
  amount: number
  installments: number
  repaid: number
  reason: string
  status: LoanStatus
  requestedDaysAgo: number
  /** Months before the current month the repayment started. */
  startMonthsAgo: number
  decidedBy: string
}

export const LOANS: readonly LoanSeed[] = [
  { seq: 1, employeeId: 'emp-004', kind: 'loan', amount: 6_000_000, installments: 6, repaid: 2_000_000, reason: 'Motorbike repair', status: 'active', requestedDaysAgo: 75, startMonthsAgo: 2, decidedBy: 'Ida Bagus Rai' },
  { seq: 2, employeeId: 'emp-009', kind: 'advance', amount: 1_500_000, installments: 1, repaid: 1_500_000, reason: 'School fees', status: 'settled', requestedDaysAgo: 50, startMonthsAgo: 1, decidedBy: 'Ida Bagus Rai' },
  { seq: 3, employeeId: 'emp-011', kind: 'loan', amount: 4_000_000, installments: 4, repaid: 0, reason: 'Home renovation after the rain', status: 'pending', requestedDaysAgo: 1, startMonthsAgo: -1, decidedBy: '' },
]
