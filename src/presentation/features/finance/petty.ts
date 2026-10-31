import type { PettyRow } from '@/application/views'

/** The link that opens a transfer from the source box back up to the float. */
export const topUpLink = (r: PettyRow) =>
  `/finance/transfer?${new URLSearchParams({ to: r.account.id, from: r.source?.id ?? '', amount: String(r.topUp), description: `Top up ${r.account.name}` })}`
