import type { Payment } from '@/domain/payment'
import type { LogEntry, LogInput } from '@/domain/logBook'
import type { PreAuth, PreAuthInput } from '@/domain/preAuth'
import type { ResolveInput, RoomCheck, RoomCheckInput } from '@/domain/roomCheck'

/** Housekeeping's round and the discrepancies it finds against the front office. */
export interface RoomCheckPort {
  /** Newest day first, then unit code. */
  checks(): Promise<RoomCheck[]>
  /** One check per room and day; saving again replaces it unless resolved (ROOM_CHECK_RESOLVED). */
  record(input: RoomCheckInput): Promise<RoomCheck>
  resolve(id: string, input: ResolveInput): Promise<RoomCheck>
}

/** Card holds taken as a stay's security deposit, through the payment gateway. */
export interface PreAuthPort {
  /** Oldest first. */
  preAuths(): Promise<PreAuth[]>
  create(input: PreAuthInput): Promise<PreAuth>
  /** Takes part or all of the hold as a card payment on the folio's room balance and lets the rest go. */
  capture(id: string, amount: number): Promise<{ preAuth: PreAuth; payment: Payment }>
  release(id: string): Promise<PreAuth>
}

/** The desk's shift log. */
export interface LogBookPort {
  /** Newest first. */
  entries(): Promise<LogEntry[]>
  write(input: LogInput): Promise<LogEntry>
  acknowledge(id: string): Promise<LogEntry>
  done(id: string, note: string): Promise<LogEntry>
}
