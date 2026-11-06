import type { RestrictionInput } from '@/domain/restriction'

export type RestrictionDraft = Omit<RestrictionInput, 'groupId'>
export const EMPTY_RESTRICTION: RestrictionDraft = { unitId: null, rule: 'min_stay', nights: 3, yearly: true, from: '', to: '', weekdays: [], note: '' }
/** The editable fields of a saved restriction. */
export const toDraft = ({ unitId, rule, nights, yearly, from, to, weekdays, note }: RestrictionDraft): RestrictionDraft => ({ unitId, rule, nights, yearly, from, to, weekdays, note })
