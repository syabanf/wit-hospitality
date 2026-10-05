/** Reads a thrown ValidationError's field map; anything else becomes a form-level message. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (error && typeof error === 'object' && 'errors' in error && typeof (error as { errors: unknown }).errors === 'object') {
    return (error as { errors: Record<string, string> }).errors
  }
  return { form: error instanceof Error ? error.message : 'Something went wrong.' }
}
