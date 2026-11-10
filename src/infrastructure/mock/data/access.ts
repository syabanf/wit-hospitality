import type { Role, UserStatus } from '@/domain/access'
import type { ApprovalRule } from '@/domain/approval'

export interface UserSeed {
  id: string
  name: string
  email: string
  role: Role
  status: UserStatus
  locationIds: readonly string[]
  villaIds: readonly string[]
  employeeId: string | null
  lastLoginDaysAgo: number | null
  createdDaysAgo: number
}

const user = (id: string, name: string, role: Role, employeeId: string | null, extra: Partial<UserSeed> = {}): UserSeed => ({
  id: `usr-${id}`,
  name,
  email: `${id}@balivillas.id`,
  role,
  status: 'active',
  locationIds: [],
  villaIds: [],
  employeeId,
  lastLoginDaysAgo: 0,
  createdDaysAgo: 400,
  ...extra,
})

/** One login per role, a second finance signer so finance can sign what another finance user wrote, and a room attendant for the housekeeping phone list; kadek is the session the demo opens in. */
export const USERS: readonly UserSeed[] = [
  user('kadek', 'Kadek Ariani', 'manager', 'emp-001'),
  user('rama', 'Rama Wijaya', 'owner', null, { lastLoginDaysAgo: 1 }),
  user('arya', 'Arya Santoso', 'management', null, { lastLoginDaysAgo: 2 }),
  user('ida', 'Ida Bagus Rai', 'finance', 'emp-013'),
  user('made', 'Made Suryani', 'finance', null, { lastLoginDaysAgo: 1, createdDaysAgo: 200 }),
  user('nia', 'Nia Kusuma', 'hr', null, { lastLoginDaysAgo: 1 }),
  user('dian', 'Dian Permata', 'reservation', null),
  user('putu', 'Putu Eka Wijaya', 'manager', 'emp-008', { locationIds: ['loc-ubud'] }),
  user('wayan', 'Wayan Sudiarta', 'staff', 'emp-002', { villaIds: ['vil-saka'], lastLoginDaysAgo: 0 }),
  user('admin', 'System administrator', 'admin', null, { lastLoginDaysAgo: 9 }),
  user('hendra', 'Hendra Gunawan', 'investor', null, { villaIds: ['vil-karang', 'vil-pandawa'], lastLoginDaysAgo: 3, createdDaysAgo: 420 }),
  user('sophie', 'Sophie Laurent', 'investor', null, { villaIds: ['vil-lumbung'], lastLoginDaysAgo: 5, createdDaysAgo: 300 }),
  user('agus', 'Agus Pratama', 'staff', 'emp-015', { status: 'inactive', villaIds: ['vil-karang'], lastLoginDaysAgo: 61 }),
  user('sari', 'Ni Luh Putu Sari', 'staff', 'emp-003', { villaIds: ['vil-saka'] }),
]

/** Every seeded login shares the demo password. */
export const DEMO_PASSWORD = 'villa123'

export const APPROVAL_RULES: readonly ApprovalRule[] = [
  { id: 'rule-standard', name: 'Standard entries', kind: 'all', villaId: null, minAmount: 0, levels: ['manager'], active: true },
  { id: 'rule-5m', name: 'Expenses from Rp 5 jt', kind: 'cash_out', villaId: null, minAmount: 5_000_000, levels: ['manager', 'finance'], active: true },
  { id: 'rule-25m', name: 'Expenses from Rp 25 jt', kind: 'cash_out', villaId: null, minAmount: 25_000_000, levels: ['manager', 'finance', 'owner'], active: true },
  { id: 'rule-karang', name: 'Villa Karang expenses from Rp 1 jt', kind: 'cash_out', villaId: 'vil-karang', minAmount: 1_000_000, levels: ['manager', 'finance'], active: true },
]
