import { createContext, useContext } from 'react'
import type { Services } from '@/application/services'

export const ServicesContext = createContext<Services | null>(null)

/** The use cases, wired by the composition root in `src/app`. */
export function useServices(): Services {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('useServices needs a <ServicesContext.Provider> above it')
  return services
}
