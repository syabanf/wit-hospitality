import { useState } from 'react'
import type { SwapView } from '@/application/selfService'
import { SWAP_STATUS_LABEL, type SwapAction, type SwapStatus } from '@/domain/selfService'
import { shortDay } from '@/lib/dates'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import type { Tone } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { useToast } from '../../ui/useToast'
import { DecideButtons } from '../hr/DecideButtons'

const SWAP_TONE: Record<SwapStatus, Tone> = { offered: 'warning', accepted: 'info', declined: 'neutral', approved: 'success', rejected: 'danger', cancelled: 'neutral' }
const DONE: Record<Exclude<SwapAction, 'approve' | 'reject'>, string> = { accept: 'Accepted', decline: 'Declined', cancel: 'Cancelled' }

/** One line per swap: who hands which shift to whom. */
function swapLine(s: SwapView) {
  const give = `${s.shift?.name ?? 'Shift'} on ${shortDay(s.date)}`
  if (!s.counterDate) return `${s.requesterName} hands ${give} to ${s.counterpartName}`
  return `${s.requesterName} trades ${give} for ${s.counterpartName}’s ${s.counterShift?.name ?? 'shift'}${s.counterDate === s.date ? '' : ` on ${shortDay(s.counterDate)}`}`
}

interface SwapListProps {
  swaps: readonly SwapView[]
  /** The signed-in employee: the coworker answers, the requester cancels. */
  employeeId?: string | null
  /** Approve and Reject on an accepted swap, for whoever edits the roster. */
  canDecide?: boolean
  onDone: () => void
}

/** Shift swaps with the action each one waits for: the coworker's answer, then the roster editor's decision. */
export function SwapList({ swaps, employeeId = null, canDecide = false, onDone }: SwapListProps) {
  const { selfService } = useServices()
  const toast = useToast()
  const [busy, setBusy] = useState('')

  async function move(s: SwapView, action: Exclude<SwapAction, 'approve' | 'reject'>) {
    setBusy(`${s.id}:${action}`)
    try {
      await selfService.moveSwap(s.id, action)
      toast({ title: `${DONE[action]} ${s.number}`, description: action === 'accept' ? 'It waits for the roster to be approved' : undefined })
      onDone()
    } catch (e) {
      toast({ tone: 'danger', title: `Could not update ${s.number}`, description: e instanceof Error ? e.message : undefined })
    } finally {
      setBusy('')
    }
  }

  return (
    <ul className="divide-y divide-line text-sm">
      {swaps.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
          <span className="min-w-0 flex-1 basis-56">
            <span className="block">
              <span className="font-mono text-xs font-semibold">{s.number}</span> · {swapLine(s)}
            </span>
            <span className="block truncate text-xs text-muted">
              {s.villaName}
              {s.note && ` · ${s.note}`}
              {s.decisionNote && ` · ${s.decisionNote}`}
            </span>
          </span>
          <StatusPill tone={SWAP_TONE[s.status]}>{SWAP_STATUS_LABEL[s.status]}</StatusPill>
          {s.status === 'offered' && s.counterpartId === employeeId && (
            <span className="flex gap-1.5">
              <Button size="sm" variant="solid" loading={busy === `${s.id}:accept`} onClick={() => void move(s, 'accept')}>
                Accept
              </Button>
              <Button size="sm" variant="soft" loading={busy === `${s.id}:decline`} onClick={() => void move(s, 'decline')}>
                Decline
              </Button>
            </span>
          )}
          {(s.status === 'offered' || s.status === 'accepted') && s.requesterId === employeeId && (
            <Button size="sm" variant="soft" loading={busy === `${s.id}:cancel`} onClick={() => void move(s, 'cancel')}>
              Cancel swap
            </Button>
          )}
          {canDecide && s.status === 'accepted' && <DecideButtons number={s.number} decide={(to, note) => selfService.moveSwap(s.id, to === 'approved' ? 'approve' : 'reject', note)} onDone={onDone} />}
        </li>
      ))}
    </ul>
  )
}
