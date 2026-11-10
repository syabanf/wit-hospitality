/**
 * The public site's buttons and text links as complete class lists, one per tone and size. Callers
 * pick a variant and add only layout classes (margin, grid placement), never colour, border or
 * size: `cn` joins strings and does not resolve Tailwind conflicts, so a second bg- or text- class
 * would leave the colour to stylesheet order.
 */

export type ButtonTone = 'ink' | 'cream' | 'ghost-light' | 'ghost-dark'
export type ButtonSize = 'md' | 'sm'
export const BUTTON_TONES: readonly ButtonTone[] = ['ink', 'cream', 'ghost-light', 'ghost-dark']
export const BUTTON_SIZES: readonly ButtonSize[] = ['md', 'sm']

const BASE = 'inline-flex items-center justify-center gap-2 rounded-full font-semibold tracking-wide transition-colors disabled:opacity-60'

const TONE: Record<ButtonTone, string> = {
  ink: 'border border-(--s-ink) bg-(--s-ink) text-(--s-cream) hover:border-(--s-terra) hover:bg-(--s-terra)',
  cream: 'border border-(--s-cream) bg-(--s-cream) text-(--s-ink) hover:border-(--s-sand) hover:bg-(--s-sand)',
  'ghost-light': 'border border-(--s-cream)/70 bg-transparent text-(--s-cream) hover:bg-(--s-cream) hover:text-(--s-ink)',
  'ghost-dark': 'border border-(--s-ink) bg-transparent text-(--s-ink) hover:bg-(--s-ink) hover:text-(--s-cream)',
}

const SIZE: Record<ButtonSize, string> = {
  md: 'min-h-12 px-6 text-sm',
  sm: 'min-h-10 px-4 text-xs',
}

export const button = ({ tone = 'ink', size = 'md' }: { tone?: ButtonTone; size?: ButtonSize } = {}) => `${BASE} ${TONE[tone]} ${SIZE[size]}`

export type LinkTone = 'dark' | 'light'
export const LINK_TONES: readonly LinkTone[] = ['dark', 'light']

/** An underlined text link with an arrow: dark text on cream, cream text on dark sections and photos. */
export const textLink = (tone: LinkTone = 'dark') =>
  `group inline-flex items-center gap-2 border-b border-current pb-1 text-sm font-semibold tracking-wide transition-colors ${tone === 'dark' ? 'text-(--s-ink) hover:text-(--s-terra)' : 'text-(--s-cream) hover:text-(--s-sand)'}`
