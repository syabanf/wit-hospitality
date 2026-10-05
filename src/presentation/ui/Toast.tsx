import { useCallback, useState, type ReactNode } from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'
import { ToastContext, type Notify, type ToastItem } from './useToast'

let nextId = 1

/** Every mutation ends in a toast: past-tense title, the record in the description. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const notify = useCallback<Notify>(({ tone = 'success', ...toast }) => {
    const id = nextId++
    setItems((list) => [...list.slice(-2), { id, tone, ...toast }])
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 3600)
  }, [])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
        {items.map((t) => {
          const Icon = t.tone === 'success' ? CircleCheck : TriangleAlert
          return (
            <div
              key={t.id}
              role="status"
              className="pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-3 rounded-panel bg-invert px-4 py-3 text-on-invert shadow-float"
            >
              <Icon aria-hidden className={t.tone === 'success' ? 'mt-0.5 size-4' : 'mt-0.5 size-4 text-accent'} />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t.title}</p>
                {t.description && <p className="text-xs opacity-70">{t.description}</p>}
              </div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
