import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type Resource<T> =
  | { status: 'loading'; data: T | undefined; error?: undefined }
  | { status: 'ready'; data: T; error?: undefined }
  | { status: 'error'; data: T | undefined; error: Error }

interface Settled<T> {
  key: string
  data?: T
  error?: Error
}

/**
 * Loads `load()` whenever `key` changes. The key names everything the loader reads,
 * e.g. `finance.revenue:${period}`. While a new key loads, the previous data stays on
 * screen (status `loading` with `data` set) so switching a tab never flashes a skeleton.
 * Record pages pass `keepPrevious: false`: another record's data must never stand in for this one.
 */
export function useResource<T>(key: string, load: () => Promise<T>, { keepPrevious = true } = {}) {
  const loader = useRef(load)
  useLayoutEffect(() => {
    loader.current = load
  })
  const [attempt, setAttempt] = useState(0)
  const request = `${key}#${attempt}`
  const [settled, setSettled] = useState<Settled<T>>({ key: '' })

  useEffect(() => {
    let live = true
    loader.current().then(
      (data) => live && setSettled({ key: request, data }),
      (error: unknown) =>
        live &&
        setSettled((s) => ({ key: request, data: s.data, error: error instanceof Error ? error : new Error(String(error)) })),
    )
    return () => {
      live = false
    }
  }, [request])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  /** Replace the data after a mutation returns the new state. */
  const setData = useCallback((data: T) => setSettled({ key: request, data }), [request])

  const current = settled.key === request
  const data = current || keepPrevious ? settled.data : undefined
  const state: Resource<T> = !current
    ? { status: 'loading', data }
    : settled.error
      ? { status: 'error', data: keepPrevious ? settled.data : undefined, error: settled.error }
      : { status: 'ready', data: settled.data as T }
  return { ...state, reload, setData }
}
