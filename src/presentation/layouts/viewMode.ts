export type ViewMode = 'desktop' | 'mobile'

/** Console page and its phone screen, matched by path prefix; the first match wins. */
const PAIRS: ReadonlyArray<readonly [desktop: string, mobile: string]> = [
  ['/bookings/:id', '/m/bookings/:id'],
  ['/finance', '/m/cash'],
  ['/services', '/m/services'],
  ['/housekeeping', '/m/housekeeping'],
  ['/maintenance/work-orders', '/m/work-orders'],
  ['/payments', '/m/payments'],
  ['/calendar', '/m/availability'],
  ['/me', '/m/me'],
  ['/', '/m'],
]

function match(pattern: string, pathname: string): string | null | undefined {
  if (pattern.endsWith('/:id')) {
    const prefix = pattern.slice(0, -3)
    const id = pathname.startsWith(prefix) ? pathname.slice(prefix.length).split('/')[0] : ''
    return id && id !== 'new' ? id : undefined
  }
  if (pattern === '/' || pattern === '/m') return pathname === pattern ? null : undefined
  return pathname === pattern || pathname.startsWith(`${pattern}/`) ? null : undefined
}

/** The page in the other view that shows the same thing, or that view's home. */
export function counterpart(pathname: string, target: ViewMode): string {
  for (const [desktop, mobile] of PAIRS) {
    const [from, to] = target === 'mobile' ? [desktop, mobile] : [mobile, desktop]
    const id = match(from, pathname)
    if (id !== undefined) return id ? to.replace(':id', id) : to
  }
  return target === 'mobile' ? '/m' : '/'
}

export const isMobilePath = (pathname: string) => pathname === '/m' || pathname.startsWith('/m/')

const KEY = 'wit-view'

export function savedView(): ViewMode | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'desktop' || v === 'mobile' ? v : null
  } catch {
    return null
  }
}

export function saveView(mode: ViewMode) {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}
