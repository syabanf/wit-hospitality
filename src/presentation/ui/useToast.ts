import { createContext, useContext } from 'react'

export interface ToastItem {
  id: number
  title: string
  description?: string
  tone: 'success' | 'danger'
  /** A follow-up the toast offers, such as opening the record the save created. */
  action?: { label: string; run: () => void }
}

export type ToastInput = Omit<ToastItem, 'id' | 'tone'> & { tone?: ToastItem['tone'] }
export type Notify = (toast: ToastInput) => void

export const ToastContext = createContext<Notify | null>(null)

export function useToast(): Notify {
  const notify = useContext(ToastContext)
  if (!notify) throw new Error('useToast needs a <ToastProvider> above it')
  return notify
}
