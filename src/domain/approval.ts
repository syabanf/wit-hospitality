import { ROLES, type Role } from './access'
import type { ApprovalGrant, Transaction, TransactionKind } from './finance'

/**
 * Who signs a cash entry before it posts. The most specific active rule wins: a villa rule over a
 * portfolio rule, then the highest threshold the amount reaches. Without a rule one manager signs.
 */
export interface ApprovalRule {
  id: string
  name: string
  kind: TransactionKind | 'all'
  villaId: string | null
  /** The rule applies from this amount upward. */
  minAmount: number
  /** Roles that sign in order: Villa manager, then Finance, then Owner. */
  levels: readonly Role[]
  active: boolean
}

export interface ApprovalRuleInput {
  name: string
  kind: TransactionKind | 'all'
  villaId: string | null
  minAmount: number
  levels: readonly Role[]
  active: boolean
}

export const DEFAULT_LEVELS: readonly Role[] = ['manager']

export function validateApprovalRule(input: ApprovalRuleInput): Partial<Record<keyof ApprovalRuleInput, string>> {
  const errors: Partial<Record<keyof ApprovalRuleInput, string>> = {}
  if (input.name.trim().length < 3) errors.name = 'Name the rule, for example "Large expenses".'
  if (!Number.isInteger(input.minAmount) || input.minAmount < 0) errors.minAmount = 'Enter the threshold in whole rupiah, zero or more.'
  if (input.levels.length === 0) errors.levels = 'Pick at least one approver role.'
  else if (input.levels.some((r) => !ROLES.includes(r))) errors.levels = 'Pick roles from the list.'
  else if (new Set(input.levels).size !== input.levels.length) errors.levels = 'Each role signs once.'
  return errors
}

export function matchRule(rules: readonly ApprovalRule[], t: Pick<Transaction, 'kind' | 'villaId' | 'amount'>): ApprovalRule | null {
  const fits = rules.filter((r) => r.active && (r.kind === 'all' || r.kind === t.kind) && (r.villaId === null || r.villaId === t.villaId) && t.amount >= r.minAmount)
  return [...fits].sort((a, b) => Number(b.villaId !== null) - Number(a.villaId !== null) || b.minAmount - a.minAmount || Number(b.kind !== 'all') - Number(a.kind !== 'all'))[0] ?? null
}

export const requiredLevels = (rules: readonly ApprovalRule[], t: Pick<Transaction, 'kind' | 'villaId' | 'amount'>): readonly Role[] => matchRule(rules, t)?.levels ?? DEFAULT_LEVELS

export interface ApprovalProgress {
  levels: readonly Role[]
  done: number
  /** The role that signs next, or null once every level has signed. */
  next: Role | null
  complete: boolean
}

export function approvalProgress(levels: readonly Role[], approvals: readonly ApprovalGrant[]): ApprovalProgress {
  const done = Math.min(levels.length, approvals.length)
  return { levels, done, next: levels[done] ?? null, complete: done >= levels.length }
}

/** Owner and administrator may sign any level; everyone else signs only their own. */
export const canSignLevel = (role: Role, level: Role) => role === level || role === 'owner' || role === 'admin'
