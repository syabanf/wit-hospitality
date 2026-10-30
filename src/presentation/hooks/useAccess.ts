import { createContext, useContext } from 'react'
import type { Action, Module, Permissions, User } from '@/domain/access'

export interface Access {
  user: User
  permissions: Permissions
  can: (module: Module, action: Action) => boolean
  /** Re-reads the session, after a profile edit or a permission change. */
  reload: () => void
}

export const AccessContext = createContext<Access | null>(null)

/** The signed-in user and what they may do; provided by AccessProvider in the layouts. */
export function useAccess(): Access {
  const value = useContext(AccessContext)
  if (!value) throw new Error('useAccess needs an <AccessProvider> above it')
  return value
}
