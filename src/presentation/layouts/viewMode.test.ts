import { describe, expect, it } from 'vitest'
import { counterpart, isMobilePath } from './viewMode'

describe('counterpart', () => {
  it.each([
    ['/', '/m'],
    ['/bookings/bk-1308', '/m/bookings/bk-1308'],
    ['/finance', '/m/cash'],
    ['/finance/transactions/tx-33', '/m/cash'],
    ['/services/rq-7', '/m/services'],
    ['/housekeeping', '/m/housekeeping'],
    ['/maintenance/work-orders/wo-5', '/m/work-orders'],
    ['/payments/list', '/m/payments'],
    ['/me/payslips', '/m/me'],
    ['/bookings', '/m'],
    ['/bookings/new', '/m'],
    ['/bookings/groups', '/m'],
    ['/bookings/groups/bg-1', '/m/groups/bg-1'],
    ['/hr/leave', '/m'],
  ])('desktop %s opens %s on the phone', (from, to) => expect(counterpart(from, 'mobile')).toBe(to))

  it.each([
    ['/m', '/'],
    ['/m/bookings/bk-1308', '/bookings/bk-1308'],
    ['/m/bookings/bk-1308/check-in', '/bookings/bk-1308'],
    ['/m/groups/bg-1', '/bookings/groups/bg-1'],
    ['/m/cash', '/finance'],
    ['/m/services', '/services'],
    ['/m/housekeeping', '/housekeeping'],
    ['/m/work-orders', '/maintenance/work-orders'],
    ['/m/payments', '/payments'],
    ['/m/availability', '/calendar'],
    ['/m/me', '/me'],
    ['/m/menu', '/'],
  ])('phone %s opens %s on the desktop', (from, to) => expect(counterpart(from, 'desktop')).toBe(to))

  it('tells the phone app from the console', () => {
    expect(isMobilePath('/m/cash')).toBe(true)
    expect(isMobilePath('/m')).toBe(true)
    expect(isMobilePath('/maintenance')).toBe(false)
  })
})
