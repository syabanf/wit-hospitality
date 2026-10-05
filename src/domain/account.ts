export type Role = 'owner' | 'manager' | 'finance' | 'staff'
export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', manager: 'Villa manager', finance: 'Finance', staff: 'Front desk' }

export interface Profile {
  name: string
  email: string
  role: Role
  /** Location ids this person may see; empty means every location. */
  locationIds: readonly string[]
  notifyArrivals: boolean
  notifyApprovals: boolean
}

export function validateProfile(p: Pick<Profile, 'name' | 'email'>): Partial<Record<'name' | 'email', string>> {
  const errors: Partial<Record<'name' | 'email', string>> = {}
  if (p.name.trim().length < 2) errors.name = 'Enter your name.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.email = 'Enter a valid email address.'
  return errors
}
