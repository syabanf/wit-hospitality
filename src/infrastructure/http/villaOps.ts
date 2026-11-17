import type { VillaOpsPort } from '@/application/villaOpsPort'
import type { createHttpClient } from './client'

/** Villa operations over REST: api/docs/contracts/villa-operations-contract.md. */
export const villaOpsPort = (http: ReturnType<typeof createHttpClient>): VillaOpsPort => ({
  unitItems: () => http.get('unit-items'),
  saveUnitItem: (id, input) => (id ? http.patch(`unit-items/${id}`, input) : http.post('unit-items', input)),
  removeUnitItem: (id) => http.delete(`unit-items/${id}`),
  copyUnitItems: (fromUnitId, toUnitId) => http.post('unit-items/copy', { fromUnitId, toUnitId }),
  checks: () => http.get('inventory-checks'),
  recordCheck: (input) => http.post('inventory-checks', input),
  chargeLine: (checkId, itemId, input) => http.post(`inventory-checks/${checkId}/lines/${itemId}/charge`, input),
  raiseWorkOrder: (checkId, itemId) => http.post(`inventory-checks/${checkId}/lines/${itemId}/work-order`, {}),
  adjustLine: (checkId, itemId) => http.post(`inventory-checks/${checkId}/lines/${itemId}/adjust`, {}),
  meters: () => http.get('meters'),
  saveMeter: (id, input) => (id ? http.patch(`meters/${id}`, input) : http.post('meters', input)),
  readings: () => http.get('meter-readings'),
  recordReading: (input) => http.post('meter-readings', input),
  utilitySettings: () => http.get('utility-settings'),
  saveUtilitySettings: (villaId, longStayNights) => http.put(`utility-settings/${villaId}`, { longStayNights }),
  applyTemplate: (input) => http.post('preventive-plans/templates', input),
  recordUpkeep: (workOrderId, input) => http.put(`work-orders/${workOrderId}/upkeep`, input),
})
