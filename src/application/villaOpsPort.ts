import type { PreventivePlan, WorkOrder } from '@/domain/maintenance'
import type { ChargeInput, CheckInput, InventoryCheck, UnitItem, UnitItemInput } from '@/domain/unitInventory'
import type { ApplyTemplateInput, UpkeepInput } from '@/domain/upkeep'
import type { Meter, MeterInput, MeterReading, ReadingInput, UtilitySettings } from '@/domain/utilities'

/**
 * Villa operations: unit inventory lists and checks (inventory context), meters and readings and
 * upkeep templates (maintenance context). Contract: api/docs/contracts/villa-operations-contract.md.
 */
export interface VillaOpsPort {
  unitItems(): Promise<UnitItem[]>
  saveUnitItem(id: string | null, input: UnitItemInput): Promise<UnitItem>
  removeUnitItem(id: string): Promise<void>
  /** Copies the source's items the target lacks; answers the target's list. */
  copyUnitItems(fromUnitId: string, toUnitId: string): Promise<UnitItem[]>
  checks(): Promise<InventoryCheck[]>
  recordCheck(input: CheckInput): Promise<InventoryCheck>
  /** Charges a damaged or missing item to the stay's folio, once. */
  chargeLine(checkId: string, itemId: string, input: ChargeInput): Promise<InventoryCheck>
  raiseWorkOrder(checkId: string, itemId: string): Promise<InventoryCheck>
  adjustLine(checkId: string, itemId: string): Promise<InventoryCheck>

  meters(): Promise<Meter[]>
  saveMeter(id: string | null, input: MeterInput): Promise<Meter>
  readings(): Promise<MeterReading[]>
  recordReading(input: ReadingInput): Promise<MeterReading>
  utilitySettings(): Promise<UtilitySettings[]>
  saveUtilitySettings(villaId: string, longStayNights: number): Promise<UtilitySettings>

  applyTemplate(input: ApplyTemplateInput): Promise<PreventivePlan[]>
  recordUpkeep(workOrderId: string, input: UpkeepInput): Promise<WorkOrder>
}
