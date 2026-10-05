import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import { Button } from './Button'
import type { ButtonSize, ButtonVariant } from './buttonStyles'

export function ThemeToggle({ variant = 'card', size = 'icon-lg', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string }) {
  const [theme, setTheme] = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      variant={variant}
      size={size}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={className}
      onClick={() => setTheme(next)}
    >
      {theme === 'dark' ? <Sun aria-hidden className="size-5" /> : <Moon aria-hidden className="size-5" />}
    </Button>
  )
}
