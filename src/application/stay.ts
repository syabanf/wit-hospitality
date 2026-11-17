import type { Action, Module, User } from '@/domain/access'
import { validatePreferences, validateServiceWindow, type GuestPreferences, type ServiceWindow } from '@/domain/hospitality'
import { stayUrl } from '@/domain/messaging'
import { validateOrder, type GuestOrderInput } from '@/domain/serviceOrder'
import { guestNoteProblem, validateGuestRequest, type GuestRequestInput } from '@/domain/stay'
import type { Ports } from './ports'

interface Deps {
  ports: Ports
  allow: (module: Module, action: Action) => Promise<User>
  check: (errors: Record<string, string | undefined>) => void
}

/**
 * The guest's page during the stay. Every call but `issueLink` is public: the stay token is the
 * credential. Forms are checked here so the page shows each field error before a round trip.
 */
export function createStayServices({ ports, allow, check }: Deps) {
  return {
    /** The desk makes the link of a stay in house that has none (checked in before the page existed). */
    async issueLink(bookingId: string) {
      await allow('booking', 'edit')
      return ports.stay.issueLink(bookingId)
    },
    /** The guest-facing link of a stay token. */
    url: stayUrl,
    view: (token: string) => ports.stay.guestView(token),
    async askClean(token: string, note: string) {
      check({ note: guestNoteProblem(note) })
      return ports.stay.askClean(token, note)
    },
    async setServiceWindow(token: string, window: ServiceWindow) {
      check(validateServiceWindow(window))
      return ports.stay.setServiceWindow(token, window)
    },
    async placeOrder(token: string, input: GuestOrderInput) {
      check(validateOrder(input))
      return ports.stay.placeOrder(token, input)
    },
    async request(token: string, input: GuestRequestInput) {
      check(validateGuestRequest(input))
      return ports.stay.request(token, input)
    },
    quoteLateCheckout: (token: string, until: string) => ports.stay.quoteLateCheckout(token, until),
    lateCheckout: (token: string, until: string) => ports.stay.lateCheckout(token, until),
    async setPreferences(token: string, preferences: GuestPreferences) {
      check(validatePreferences(preferences))
      return ports.stay.setPreferences(token, preferences)
    },
  }
}
