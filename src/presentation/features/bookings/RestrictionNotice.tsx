import type { Violation } from '@/domain/restriction'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'

/**
 * The rules a stay breaks, and the reason field for someone who may sell past them. A channel stay
 * only warns, since the channel already sold it.
 */
export function RestrictionNotice({ id, violations, channel, mayOverride, reason, onReason, error }: { id: string; violations: readonly Violation[]; channel: boolean; mayOverride: boolean; reason: string; onReason: (reason: string) => void; error?: string }) {
  if (violations.length === 0) return null
  return (
    <div className="space-y-3">
      <div role="alert" className={`rounded-panel p-3.5 text-sm ${channel ? 'bg-warning-soft text-warning' : 'bg-danger-soft text-danger'}`}>
        {channel ? 'The channel sold this stay; it is kept with a warning against these rules:' : 'The stay breaks these rules:'}
        <ul className="mt-1 list-disc pl-4">
          {violations.map((v) => (
            <li key={v.rule}>{v.message}</li>
          ))}
        </ul>
      </div>
      {!channel &&
        (mayOverride ? (
          <Field label="Sell past the rules because" htmlFor={id} error={error} hint="Kept on the booking and in the audit trail">
            <Input id={id} value={reason} onChange={(e) => onReason(e.target.value)} placeholder="Owner agreed, returning guest" />
          </Field>
        ) : (
          <p className="text-xs text-muted">Pick another room or dates, or ask a villa manager to sell past the rules.</p>
        ))}
    </div>
  )
}

/** Whether the stay may go ahead: no rule broken, a channel stay, or a reason long enough from someone who may override. */
export const restrictionCleared = (check: { violations: readonly Violation[]; channel: boolean; mayOverride: boolean } | null | undefined, reason: string) =>
  !check || check.violations.length === 0 || check.channel || (check.mayOverride && reason.trim().length >= 3)
