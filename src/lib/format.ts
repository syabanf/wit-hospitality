const idr = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const idrCompact = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  notation: 'compact',
  maximumFractionDigits: 1,
})
const plain = new Intl.NumberFormat('en-US')

/** Rupiah without decimals: "Rp 12.500.000". */
export const money = (value: number) => idr.format(value)
/** Rupiah for axis ticks: "Rp 12,5 jt". */
export const moneyCompact = (value: number) => idrCompact.format(value)
export const count = (value: number) => plain.format(value)

/** 0.083 -> "8.3%". Pass `signed` for "+8.3%" / "-2.1%". */
export function percent(ratio: number, { signed = false, digits = 1 } = {}): string {
  const text = `${Math.abs(ratio * 100).toFixed(digits)}%`
  if (!signed) return ratio < 0 ? `-${text}` : text
  return `${ratio < 0 ? '-' : '+'}${text}`
}

/** "3 nights", "1 night". */
export const plural = (n: number, word: string) => `${plain.format(n)} ${word}${n === 1 ? '' : 's'}`
