import { RouterProvider } from 'react-router/dom'
import { ServicesContext } from '@/presentation/hooks/useServices'
import { ToastProvider } from '@/presentation/ui/Toast'
import { services } from './container'
import { router } from './router'

export function App() {
  return (
    <ServicesContext.Provider value={services}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ServicesContext.Provider>
  )
}
