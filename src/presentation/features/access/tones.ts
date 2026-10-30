import type { AuditAction } from '@/domain/access'
import type { Tone } from '../../ui/Badge'

export const AUDIT_TONE: Record<AuditAction, Tone> = {
  create: 'success',
  update: 'info',
  delete: 'danger',
  status: 'neutral',
  approve: 'success',
  reject: 'danger',
  login: 'neutral',
  logout: 'neutral',
  denied: 'accent',
}

/** "2026-10-05T09:30:00" as "09:30". */
export const timeOf = (at: string) => at.slice(11, 16)
