import { useSearchParams } from 'react-router'

/** List filters kept in the URL under `keys`; `layout` survives, `page` resets on every change. */
export function useFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams()
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ''])) as Record<K, string>
  function set(next: Partial<Record<K, string>>) {
    const search = new URLSearchParams(params)
    for (const key of keys) {
      const value = key in next ? next[key] : values[key]
      if (value) search.set(key, value as string)
      else search.delete(key)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }
  function clear() {
    setParams(params.get('layout') ? { layout: params.get('layout') as string } : {}, { replace: true })
  }
  return { values, set, clear, active: keys.some((k) => Boolean(values[k])) }
}
