import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'wit-theme'
// wit-allow: the browser chrome colour is a literal because meta[theme-color] cannot read a CSS variable.
const THEME_COLOR: Record<Theme, string> = { light: '#f1f0f1', dark: '#0d0d0f' }

const current = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

/** Every switch on screen follows the `data-theme` attribute, so two toggles never disagree. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/**
 * Light is the default. Dark is an opt-in stored per browser; index.html applies it
 * before first paint, and this hook keeps the attribute, storage and theme-color in step.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, current)

  const setTheme = useCallback((next: Theme) => {
    const root = document.documentElement
    if (next === 'dark') root.dataset.theme = 'dark'
    else delete root.dataset.theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next])
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Private mode or blocked storage: the choice lasts for this page only.
    }
  }, [])

  return [theme, setTheme] as const
}
