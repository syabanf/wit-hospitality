import { describe, expect, it } from 'vitest'
import { BUTTON_SIZES, BUTTON_TONES, button, LINK_TONES, textLink } from './buttons'

const TEXT_SIZES = /^text-(xs|sm|base|lg|xl|\dxl|left|center|right)$/
const BORDER_WIDTHS = /^border(-[trblxy])?(-\d+)?$/

/** The utility group a class belongs to under its variant prefix, or null for groups the check ignores. */
function group(cls: string): string | null {
  const at = cls.lastIndexOf(':')
  const variant = at < 0 ? '' : cls.slice(0, at + 1)
  const name = at < 0 ? cls : cls.slice(at + 1)
  if (name.startsWith('bg-')) return `${variant}bg`
  if (TEXT_SIZES.test(name)) return `${variant}text-size`
  if (name.startsWith('text-')) return `${variant}text-colour`
  if (name.startsWith('border-') && !BORDER_WIDTHS.test(name)) return `${variant}border-colour`
  for (const g of ['min-h-', 'px-', 'rounded-']) if (name.startsWith(g)) return `${variant}${g}`
  return null
}

/** Pairs of classes from the same group under the same variant. */
function clashes(classes: string): string[] {
  const seen = new Map<string, string>()
  const out: string[] = []
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const g = group(cls)
    if (!g) continue
    const before = seen.get(g)
    if (before) out.push(`${before} / ${cls}`)
    seen.set(g, cls)
  }
  return out
}

describe('site buttons', () => {
  const variants = BUTTON_TONES.flatMap((tone) => BUTTON_SIZES.map((size) => [`${tone} ${size}`, button({ tone, size })] as const))

  it.each(variants)('%s carries one class per colour and size group', (_name, classes) => {
    expect(clashes(classes)).toEqual([])
  })

  it.each(LINK_TONES.map((t) => [t, textLink(t)] as const))('the %s text link carries one colour', (_name, classes) => {
    expect(clashes(classes)).toEqual([])
  })

  it('catches a layered colour', () => {
    expect(clashes(`${button({ tone: 'ink' })} bg-(--s-cream) text-(--s-ink)`)).toHaveLength(2)
  })
})
