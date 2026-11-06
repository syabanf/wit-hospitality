import type { BudgetPort } from '@/application/ports'
import { allowedVilla, can, ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import { findById, RuleError } from '@/domain/errors'
import { validateBudget } from '@/domain/revenue'
import type { MockState } from './state'

interface BudgetContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  today: () => string
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
}

/** Budgets per villa and year. Editing needs Edit in Finance and the villa in the person's scope. */
export function createBudgetPort({ s, later, today, user, refuse, log }: BudgetContext): BudgetPort {
  return {
    budgets: () => later(() => structuredClone(s.budgets)),
    save: (input) =>
      later(() => {
        const me = user()
        const villa = findById(s.villas, input.villaId, 'villa')
        if (!can(s.permissions, me.role, 'finance', 'edit') || !allowedVilla(me, villa)) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot edit the budget of ${villa.name}.`)
        refuse(validateBudget(input))
        const at = s.budgets.findIndex((b) => b.villaId === input.villaId && b.year === input.year)
        const budget = { villaId: input.villaId, year: input.year, months: input.months.map((m) => ({ ...m })), updatedBy: me.name, updatedOn: today() }
        if (at >= 0) s.budgets[at] = budget
        else s.budgets.push(budget)
        log(at >= 0 ? 'update' : 'create', 'budget', `${input.villaId}-${input.year}`, `Saved the ${input.year} budget of ${villa.name}`)
        return structuredClone(budget)
      }),
  }
}
