/** Splits "Yoga deck, Beach club" into clean extra ids. */
export const splitCustom = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean)
