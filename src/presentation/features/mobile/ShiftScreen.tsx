import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { POP } from '../../ui/pop'
import { Skeleton } from '../../ui/States'
import { ShiftFigures } from '../finance/DrawerCount'
import { CloseShiftForm, OpenShiftForm } from '../finance/ShiftForms'
import { Screen } from './Screen'

/** My cashier shift: open it on a counted float, watch the running totals, close it on a counted drawer. */
export function ShiftScreen() {
  const { cashier } = useServices()
  const desk = useResource('cashier.desk', () => cashier.desk())
  const d = desk.data
  const mine = d?.mine ?? null

  return (
    <Screen title="My shift" band="ink">
      {!d ? (
        <Skeleton className="h-40 rounded-[28px]" />
      ) : mine ? (
        <>
          <section aria-label={mine.number} className={cn('rounded-[28px] p-5 shadow-pop', POP.ink)}>
            <p className="text-sm font-semibold">
              {mine.number} · {mine.accountName}
            </p>
            <p className="mt-3 text-[34px] leading-none font-semibold tracking-tight tabular">{money(mine.totals.expected)}</p>
            <p className="mt-1 text-xs opacity-70">Should be in the drawer now</p>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-[18px] bg-white/10 p-3">
                <p className="opacity-70">Cash in</p>
                <p className="mt-1 text-base font-semibold tabular">{money(mine.totals.cashIn)}</p>
              </div>
              <div className="rounded-[18px] bg-white/10 p-3">
                <p className="opacity-70">Cash out</p>
                <p className="mt-1 text-base font-semibold tabular">{money(mine.totals.cashOut)}</p>
              </div>
            </div>
            <Link to={`/finance/shifts/${mine.id}`} className="mt-3 inline-block text-xs underline opacity-80">
              Entries and report in the console
            </Link>
          </section>
          <section aria-labelledby="m-close" className="rounded-[26px] bg-card p-4 shadow-card">
            <h2 id="m-close" className="mb-3 text-base font-semibold">
              Count and close
            </h2>
            <CloseShiftForm shift={mine} policy={d.policy} onClosed={desk.reload} />
          </section>
        </>
      ) : (
        <>
          <section aria-labelledby="m-open" className="rounded-[26px] bg-card p-4 shadow-card">
            <h2 id="m-open" className="mb-3 text-base font-semibold">
              Open a shift
            </h2>
            <OpenShiftForm desk={d} onOpened={desk.reload} />
          </section>
          {d.cashboxes
            .filter((c) => c.open)
            .map((c) => (
              <section key={c.account.id} aria-label={c.account.name} className="rounded-[22px] bg-card p-4 shadow-card">
                <p className="text-sm font-semibold">
                  {c.account.name}: {c.open?.cashierName} on {c.open?.number}
                </p>
                {c.open && <ShiftFigures float={c.open.float} totals={c.open.totals} className="mt-2" />}
              </section>
            ))}
        </>
      )}
    </Screen>
  )
}
