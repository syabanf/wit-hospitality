import type { ComponentType } from 'react'
import { createBrowserRouter } from 'react-router'
import { NotFound } from '@/presentation/features/NotFound'
import { DashboardShell } from '@/presentation/layouts/DashboardShell'
import { MobileShell } from '@/presentation/layouts/MobileShell'

type PhoneScreens = typeof import('@/presentation/features/mobile')

/** Desktop pages load one chunk each; the phone screens share one chunk the desktop never downloads. */
const page = (load: () => Promise<{ default: ComponentType }>) => async () => ({ Component: (await load()).default })
const phone = (pick: (screens: PhoneScreens) => ComponentType) => async () => ({
  Component: pick(await import('@/presentation/features/mobile')),
})

export const router = createBrowserRouter([
  {
    element: <DashboardShell />,
    children: [
      { index: true, lazy: page(() => import('@/presentation/features/dashboard/DashboardPage')) },
      { path: 'calendar', lazy: page(() => import('@/presentation/features/calendar/CalendarPage')) },
      { path: 'bookings', lazy: page(() => import('@/presentation/features/bookings/BookingsPage')) },
      { path: 'bookings/new', lazy: page(() => import('@/presentation/features/bookings/NewBookingPage')) },
      { path: 'bookings/:id', lazy: page(() => import('@/presentation/features/bookings/BookingPage')) },
      { path: 'guests', lazy: page(() => import('@/presentation/features/guests/GuestsPage')) },
      { path: 'guests/:id', lazy: page(() => import('@/presentation/features/guests/GuestPage')) },
      { path: 'services', lazy: page(() => import('@/presentation/features/services/ServicesPage')) },
      { path: 'services/:id', lazy: page(() => import('@/presentation/features/services/ServiceRequestPage')) },
      { path: 'property', lazy: page(() => import('@/presentation/features/property/PropertyPage')) },
      { path: 'property/new', lazy: page(() => import('@/presentation/features/property/PropertyWizardPage')) },
      { path: 'master', lazy: page(() => import('@/presentation/features/master/MasterHubPage')) },
      ...['locations', 'villas', 'room-types', 'units', 'airbnb-accounts', 'listings', 'cash-accounts', 'categories'].map((slug) => ({ path: `master/${slug}`, lazy: page(() => import('@/presentation/features/master/MasterTablePage')) })),
      { path: 'property/villas/:id', lazy: page(() => import('@/presentation/features/property/VillaPage')) },
      { path: 'property/units/:id', lazy: page(() => import('@/presentation/features/property/UnitPage')) },
      { path: 'airbnb', lazy: page(() => import('@/presentation/features/airbnb/AirbnbPage')) },
      { path: 'airbnb/accounts/:id', lazy: page(() => import('@/presentation/features/airbnb/AccountPage')) },
      { path: 'finance', lazy: page(() => import('@/presentation/features/finance/FinancePage')) },
      { path: 'finance/accounts/:id', lazy: page(() => import('@/presentation/features/finance/CashAccountPage')) },
      ...['transactions', 'cash-in', 'cash-out', 'approvals'].map((slug) => ({ path: `finance/${slug}`, lazy: page(() => import('@/presentation/features/finance/TransactionsPage')) })),
      { path: 'finance/transactions/new', lazy: page(() => import('@/presentation/features/finance/NewTransactionPage')) },
      { path: 'finance/transactions/:id', lazy: page(() => import('@/presentation/features/finance/TransactionPage')) },
      { path: 'finance/categories', lazy: page(() => import('@/presentation/features/finance/CategoriesPage')) },
      { path: 'settings', lazy: page(() => import('@/presentation/features/settings/SettingsPage')) },
      { path: '*', Component: NotFound },
    ],
  },
  {
    path: 'm',
    element: <MobileShell />,
    children: [
      { index: true, lazy: phone((s) => s.HomeScreen) },
      { path: 'availability', lazy: phone((s) => s.AvailabilityScreen) },
      { path: 'cash', lazy: phone((s) => s.CashScreen) },
      { path: 'bookings/:id', lazy: phone((s) => s.BookingScreen) },
      { path: 'bookings/:id/check-in', lazy: phone((s) => s.CheckInScreen) },
      { path: 'bookings/:id/check-out', lazy: phone((s) => s.CheckOutScreen) },
      { path: 'services', lazy: phone((s) => s.ServicesScreen) },
      { path: 'menu', lazy: phone((s) => s.MenuScreen) },
    ],
  },
])
