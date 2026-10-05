/** Joins truthy class names. Tailwind order conflicts are resolved by the caller, not here. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
