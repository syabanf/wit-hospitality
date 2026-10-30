import type { Role } from './access'

export { ROLE_LABEL, type Role } from './access'

/** The signed-in person as the console shows them: the user record plus notification choices. */
export interface Profile {
  userId: string
  name: string
  email: string
  role: Role
  /** Location ids this person may see; empty means every location. */
  locationIds: readonly string[]
  villaIds: readonly string[]
  employeeId: string | null
  notifyArrivals: boolean
  notifyApprovals: boolean
}

export function validateProfile(p: Pick<Profile, 'name' | 'email'>): Partial<Record<'name' | 'email', string>> {
  const errors: Partial<Record<'name' | 'email', string>> = {}
  if (p.name.trim().length < 2) errors.name = 'Enter your name.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.email = 'Enter a valid email address.'
  return errors
}
