/**
 * Composition root: the one place that picks adapters and wires them into the use cases.
 * Set VITE_API_URL (for example https://host/api/v1) to run the same UI against the Go API.
 */
import { createPerformance, type AppServices } from '@/application/performance'
import { createServices } from '@/application/services'
import { systemClock } from '@/infrastructure/clock'
import { createHttpPorts } from '@/infrastructure/http'
import { createMockPorts } from '@/infrastructure/mock'

const apiUrl = import.meta.env.VITE_API_URL as string | undefined

const base = createServices(apiUrl ? createHttpPorts(apiUrl, systemClock) : createMockPorts(systemClock))

export const services: AppServices = { ...base, performance: createPerformance(base) }
