import { useNavigate } from 'react-router'
import type { Unit } from '@/domain/property'
import type { RatePlan } from '@/domain/ratePlan'
import { money } from '@/lib/format'
import type { ToastInput } from '../../ui/useToast'

/** What a unit save returns: the unit, and the rate plan its room type started from the unit's base price, if any. */
export interface UnitSaved {
  unit: Unit
  newPlan: RatePlan | null
}

/** The toast after a unit save; when the save started the room type's rate plan, it says so and links to it. */
export function useUnitToast() {
  const navigate = useNavigate()
  return (title: string, { unit, newPlan }: UnitSaved): ToastInput =>
    newPlan && unit.groupId
      ? { title, description: `Started its room type's rate plan from the base price: ${money(newPlan.weekdayRate)} on weekdays, ${money(newPlan.weekendRate)} on weekends.`, action: { label: 'Edit the rate plan', run: () => navigate(`/property/room-types/${unit.groupId}`) } }
      : { title }
}
