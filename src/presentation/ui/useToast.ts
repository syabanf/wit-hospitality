import { createContext, useContext } from 'react'

export interface ToastItem {
  id: number
  title: string
  description?: string
  tone: 'success' | 'danger'
}

export type Notify = (toast: Omit<ToastItem, 'id' | 'tone'> & { tone?: ToastItem['tone'] }) => void

export const ToastContext = createContext<Notify | null>(null)

export function useToast(): Notify {
  const notify = useContext(ToastContext)
  if (!notify) throw new Error('useToast needs a <ToastProvider> above it')
  return notify
}
