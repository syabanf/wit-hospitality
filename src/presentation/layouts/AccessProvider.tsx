import type { ReactNode } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router'
import { can, portalOnly } from '@/domain/access'
import { AccessContext } from '../hooks/useAccess'
import { useResource } from '../hooks/useResource'
import { useServices } from '../hooks/useServices'
import { CardSkeleton, ErrorState } from '../ui/States'

/** Every seeded demo login shares this password; `?as=wayan` on any page signs in as that user first. */
const DEMO_PASSWORD = 'villa123'

/** Loads the session once per shell and sends everyone without one to the sign-in page. */
/** `operator`: a villa owner landing on a console page goes to the owner portal instead. */
export function AccessProvider({ children, operator = false }: { children: ReactNode; operator?: boolean }) {
  const { access } = useServices()
  const { pathname, search } = useLocation()
  const [params] = useSearchParams()
  const as = params.get('as')
  const context = useResource(`access.context:${as ?? ''}`, async () => {
    if (as) await access.login({ email: `${as}@balivillas.id`, password: DEMO_PASSWORD })
    return access.context()
  })
  if (context.status === 'error' && !context.data) {
    const code = (context.error as { code?: string }).code
    if (code === 'UNAUTHENTICATED') return <Navigate to="/login" replace state={{ from: `${pathname}${search}` }} />
    return (
      <div className="p-6">
        <ErrorState error={context.error} onRetry={context.reload} />
      </div>
    )
  }
  if (!context.data) {
    return (
      <div className="p-6">
        <CardSkeleton lines={4} />
      </div>
    )
  }
  const { user, permissions } = context.data
  if (operator && portalOnly(permissions, user.role)) return <Navigate to="/portal" replace />
  return <AccessContext.Provider value={{ user, permissions, can: (module, action) => can(permissions, user.role, module, action), reload: context.reload }}>{children}</AccessContext.Provider>
}
