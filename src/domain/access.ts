import { withinRange, type IsoDate } from '@/lib/dates'

export type Role = 'owner' | 'management' | 'finance' | 'hr' | 'reservation' | 'manager' | 'staff' | 'admin'
export const ROLES: readonly Role[] = ['owner', 'management', 'finance', 'hr', 'reservation', 'manager', 'staff', 'admin']
export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  management: 'Management',
  finance: 'Finance',
  hr: 'HR',
  reservation: 'Reservation',
  manager: 'Villa manager',
  staff: 'Staff',
  admin: 'Administrator',
}

export type Module = 'dashboard' | 'property' | 'airbnb' | 'booking' | 'guest' | 'services' | 'maintenance' | 'payments' | 'finance' | 'approval' | 'hr' | 'payroll' | 'reports' | 'access' | 'master' | 'me'
export const MODULES: readonly Module[] = ['dashboard', 'property', 'airbnb', 'booking', 'guest', 'services', 'maintenance', 'payments', 'finance', 'approval', 'hr', 'payroll', 'reports', 'access', 'master', 'me']
export const MODULE_LABEL: Record<Module, string> = {
  dashboard: 'Dashboard',
  property: 'Property',
  airbnb: 'Airbnb',
  booking: 'Booking',
  guest: 'Guest',
  services: 'Room services',
  finance: 'Finance',
  approval: 'Approval',
  hr: 'HR',
  payroll: 'Payroll',
  reports: 'Reports',
  access: 'Access and security',
  master: 'Master data',
  me: 'Employee area',
  maintenance: 'Maintenance',
  payments: 'Payments',
}

export type Action = 'view' | 'create' | 'edit' | 'submit' | 'approve' | 'post' | 'report' | 'catalog' | 'comp'
export const ACTIONS: readonly Action[] = ['view', 'create', 'edit', 'submit', 'approve', 'post', 'report', 'catalog', 'comp']
export const ACTION_LABEL: Record<Action, string> = { view: 'View', create: 'Create', edit: 'Edit', submit: 'Submit', approve: 'Approve', post: 'Post', report: 'Report', catalog: 'Edit menu', comp: 'Give free' }

/** Actions that mean something in one module only: the room service menu and complimentary items. */
const MODULE_ONLY: Partial<Record<Action, Module>> = { catalog: 'services', comp: 'services' }
export const actionsFor = (m: Module) => ACTIONS.filter((a) => (MODULE_ONLY[a] ?? m) === m)

/** Per role, per module, the actions it may take. */
export type Permissions = Record<Role, Record<Module, readonly Action[]>>

const ALL: readonly Action[] = ACTIONS
const READ: readonly Action[] = ['view']
const WORK: readonly Action[] = ['view', 'create', 'edit', 'submit']
const NONE: readonly Action[] = []

const grant = (pick: (m: Module) => readonly Action[]): Record<Module, readonly Action[]> => Object.fromEntries(MODULES.map((m) => [m, pick(m)])) as Record<Module, readonly Action[]>

/** The matrix the client described: owner sees and approves everything, staff work their own module. */
/** Maintenance per role: managers run it, staff report and work jobs, finance and management read and report. */
const MAINTENANCE: Record<Role, readonly Action[]> = { owner: ALL, admin: ALL, manager: ALL, staff: WORK, finance: ['view', 'report'], management: ['view', 'report'], hr: READ, reservation: READ }
/** Guest payments per role: finance runs them, the desk and reservations take them, management reads. */
const PAYMENTS: Record<Role, readonly Action[]> = { owner: ALL, admin: ALL, finance: ALL, management: ['view', 'report'], manager: ['view', 'create', 'submit'], reservation: ['view', 'create', 'submit'], staff: ['view', 'create'], hr: NONE }
/** Room services per role: managers run the menu and may give items free, the desk takes and works orders, finance reads. */
const SERVICES: Record<Role, readonly Action[]> = { owner: ALL, admin: ALL, manager: [...WORK, 'approve', 'catalog', 'comp'], management: [...WORK, 'report'], staff: WORK, reservation: ['view', 'create'], finance: ['view', 'report'], hr: NONE }
const withMaintenance = (role: Role, perms: Record<Module, readonly Action[]>) => ({ ...perms, maintenance: MAINTENANCE[role], payments: PAYMENTS[role], services: SERVICES[role] })

const BASE_PERMISSIONS: Permissions = {
  owner: grant(() => ALL),
  admin: grant((m) => (m === 'payroll' || m === 'finance' ? [...WORK, 'report'] : ALL)),
  management: grant((m) => (m === 'access' ? NONE : m === 'finance' || m === 'payroll' ? ['view', 'approve', 'report'] : m === 'reports' || m === 'dashboard' ? ['view', 'report'] : WORK)),
  finance: grant((m) => (m === 'finance' || m === 'approval' ? ALL : m === 'payroll' ? ['view', 'approve', 'post', 'report'] : m === 'reports' || m === 'dashboard' ? ['view', 'report'] : m === 'access' || m === 'hr' ? NONE : READ)),
  hr: grant((m) => (m === 'hr' || m === 'payroll' ? [...WORK, 'approve', 'report'] : m === 'me' ? ALL : m === 'reports' ? ['view', 'report'] : m === 'dashboard' ? READ : NONE)),
  reservation: grant((m) => (m === 'booking' || m === 'guest' || m === 'airbnb' ? WORK : m === 'dashboard' || m === 'property' || m === 'services' || m === 'me' ? READ : m === 'reports' ? ['view', 'report'] : NONE)),
  manager: grant((m) => (m === 'access' || m === 'payroll' ? NONE : m === 'approval' ? ['view', 'approve'] : m === 'hr' ? ['view', 'approve'] : m === 'finance' ? WORK : m === 'reports' ? ['view', 'report'] : m === 'master' ? READ : m === 'me' ? ALL : m === 'booking' || m === 'guest' ? [...WORK, 'approve'] : WORK)),
  staff: grant((m) => (m === 'booking' || m === 'guest' || m === 'services' || m === 'finance' ? WORK : m === 'dashboard' || m === 'property' ? READ : m === 'me' ? ALL : NONE)),
}

const fitted = (perms: Record<Module, readonly Action[]>) => grant((m) => perms[m].filter((a) => actionsFor(m).includes(a)))
export const DEFAULT_PERMISSIONS: Permissions = Object.fromEntries(ROLES.map((r) => [r, fitted(withMaintenance(r, BASE_PERMISSIONS[r]))])) as Permissions

export const can = (permissions: Permissions, role: Role, module: Module, action: Action) => permissions[role]?.[module]?.includes(action) ?? false

export type UserStatus = 'active' | 'inactive'

export interface User {
  id: string
  name: string
  email: string
  role: Role
  status: UserStatus
  /** Locations this person may see; empty means every location. */
  locationIds: readonly string[]
  /** Villas this person may see; empty means every villa inside the locations. */
  villaIds: readonly string[]
  /** The employee record behind this login, for the employee area. */
  employeeId: string | null
  lastLoginOn: IsoDate | null
  createdOn: IsoDate
}

export interface UserInput {
  name: string
  email: string
  role: Role
  status: UserStatus
  locationIds: readonly string[]
  villaIds: readonly string[]
  employeeId: string | null
}

export function validateUser(input: UserInput, users: readonly User[], excludeId?: string): Partial<Record<keyof UserInput, string>> {
  const errors: Partial<Record<keyof UserInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the person’s name.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter a valid email address.'
  else if (users.some((u) => u.email.toLowerCase() === input.email.toLowerCase() && u.id !== excludeId)) errors.email = `${input.email} already has a login.`
  if (!ROLES.includes(input.role)) errors.role = 'Pick a role.'
  return errors
}

export interface LoginInput {
  email: string
  password: string
}

export interface PasswordChange {
  current: string
  next: string
  confirm: string
}

export function validatePasswordChange(p: PasswordChange): Partial<Record<keyof PasswordChange, string>> {
  const errors: Partial<Record<keyof PasswordChange, string>> = {}
  if (!p.current) errors.current = 'Enter the current password.'
  if (p.next.length < 8) errors.next = 'Use at least 8 characters.'
  else if (p.next === p.current) errors.next = 'Pick a password you have not used.'
  if (p.confirm !== p.next) errors.confirm = 'The two passwords differ.'
  return errors
}

/** Whether a user may see a villa: empty lists mean no restriction. */
export function allowedVilla(user: Pick<User, 'locationIds' | 'villaIds'>, villa: { id: string; locationId: string }): boolean {
  if (user.villaIds.length) return user.villaIds.includes(villa.id)
  if (user.locationIds.length) return user.locationIds.includes(villa.locationId)
  return true
}

export type AuditAction = 'create' | 'update' | 'delete' | 'status' | 'approve' | 'reject' | 'login' | 'logout' | 'denied'
export const AUDIT_ACTIONS: readonly AuditAction[] = ['create', 'update', 'delete', 'status', 'approve', 'reject', 'login', 'logout', 'denied']
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  status: 'Status change',
  approve: 'Approved',
  reject: 'Rejected',
  login: 'Signed in',
  logout: 'Signed out',
  denied: 'Refused',
}

/** One line of the audit trail: who did what to which record, with the values before and after. */
export interface AuditEntry {
  id: string
  /** ISO date-time. */
  at: string
  userId: string
  userName: string
  role: Role
  action: AuditAction
  entity: string
  entityId: string
  summary: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export interface AuditFilter {
  action?: AuditAction | 'all'
  entity?: string
  userId?: string
  query?: string
  from?: string
  to?: string
}

export function filterAudit(list: readonly AuditEntry[], f: AuditFilter): AuditEntry[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((e) => {
    if (f.action && f.action !== 'all' && e.action !== f.action) return false
    if (f.entity && e.entity !== f.entity) return false
    if (f.userId && e.userId !== f.userId) return false
    if (!withinRange(e.at.slice(0, 10), f.from, f.to)) return false
    if (q && ![e.summary, e.entityId, e.userName, e.entity].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}
