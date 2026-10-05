import { useSearchParams } from 'react-router'

export type Layout = 'cards' | 'table'

/** Cards or table for a page, kept in the URL as `layout=table`, so Back and shared links keep it. */
export function useLayout(): [Layout, (layout: Layout) => void] {
  const [params, setParams] = useSearchParams()
  const layout: Layout = params.get('layout') === 'table' ? 'table' : 'cards'
  return [
    layout,
    (next) => {
      const search = new URLSearchParams(params)
      if (next === 'table') search.set('layout', 'table')
      else search.delete('layout')
      search.delete('page')
      setParams(search, { replace: true })
    },
  ]
}
