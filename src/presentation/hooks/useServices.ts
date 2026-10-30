import { createContext, useContext } from 'react'
import type { AppServices } from '@/application/performance'

export const ServicesContext = createContext<AppServices | null>(null)

/** The use cases, wired by the composition root in `src/app`. */
export function useServices(): AppServices {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('useServices needs a <ServicesContext.Provider> above it')
  return services
}
