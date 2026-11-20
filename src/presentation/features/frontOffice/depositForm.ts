import type { CardBrand, DepositChoice, DepositMethod } from '@/domain/preAuth'

/** The card of a hold as the form holds it: brand, last four digits, approval code, last day. Never the card number. */
export const readCard = (f: FormData): NonNullable<DepositChoice['card']> => ({
  brand: String(f.get('cardBrand') ?? 'visa') as CardBrand,
  last4: String(f.get('cardLast4') ?? '').trim(),
  approvalCode: String(f.get('cardApproval') ?? ''),
  expiresOn: String(f.get('cardExpires') ?? ''),
})

/** How the guest left the deposit, read from the check-in form. */
export function depositChoice(f: FormData): DepositChoice {
  const method = (String(f.get('depositMethod') ?? 'cash') as DepositMethod) || 'cash'
  return method === 'preauth' ? { method, card: readCard(f) } : { method }
}
