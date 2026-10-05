/** Pop surfaces: bright WIT feature cards. Each entry pairs the fill with the text colour that passes on it. */
export type Pop = 'red' | 'blue' | 'ink' | 'blush' | 'mist'

export const POP: Record<Pop, string> = {
  red: 'bg-pop-red text-white',
  blue: 'bg-pop-blue text-ink',
  ink: 'bg-pop-ink text-white ring-1 ring-white/10',
  blush: 'bg-pop-blush text-ink',
  mist: 'bg-pop-mist text-ink',
}

/** Order for lists that cycle pops (shortcut tiles, menu, avatars). */
export const POP_ORDER: readonly Pop[] = ['red', 'blue', 'ink', 'blush', 'mist']
