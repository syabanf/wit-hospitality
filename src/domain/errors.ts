/** A lookup by id found nothing. Pages show a "not found" state instead of a crash. */
export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`No ${what} with id "${id}"`)
    this.name = 'NotFoundError'
  }
}

/** Finds by id or throws NotFoundError, so every detail use case fails the same way. */
export function findById<T extends { id: string }>(list: readonly T[], id: string, what: string): T {
  const found = list.find((item) => item.id === id)
  if (!found) throw new NotFoundError(what, id)
  return found
}

/** A business rule refused the change. `code` matches the API error codes (BOOKING_OVERLAP, ...). */
export class RuleError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RuleError'
    this.code = code
  }
}
