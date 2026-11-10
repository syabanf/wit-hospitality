/**
 * Copy the home and about pages share. Each service names something the console runs today, so
 * the site promises nothing the team cannot show.
 */

export interface ServiceLine {
  title: string
  text: string
  /** A page that shows it, when there is one. */
  to?: string
  link?: string
}

export const GUEST_SERVICES: readonly ServiceLine[] = [
  { title: 'Stays', text: 'Book a room direct at our own nightly rates, with service and PB1 shown before you ask.', to: '/stay/search', link: 'Find dates' },
  { title: 'In-villa dining', text: 'Breakfast, lunch and dinner from the villa kitchen, served on your terrace or by the pool.' },
  { title: 'Spa', text: 'Therapists come to your villa for massages and treatments at the menu price.' },
  { title: 'Tours and transfers', text: 'Airport cars, drivers for the day and guided trips, booked through the villa and paid on your bill.' },
  { title: 'Online check-in', text: 'We send a link before you arrive. Fill in your passport and arrival time and skip the desk.' },
]

export const OWNER_SERVICES: readonly ServiceLine[] = [
  { title: 'Full management', text: 'Our team runs the villa day to day: guests, staff, suppliers and the front desk.' },
  { title: 'Revenue management', text: 'We set nightly prices, stay rules and channel listings, and check occupancy and rate every week.' },
  { title: 'Monthly owner statements', text: 'Revenue, costs, our fee and your payout, line by line, approved and sent each month.' },
  { title: 'Owner portal', text: 'Sign in to see your calendar, stays, statements, payouts and documents whenever you like.', to: '/portal', link: 'Owner portal sign in' },
  { title: 'Maintenance and housekeeping', text: 'Cleaning rounds, repair tickets and planned upkeep, each one logged against your villa.' },
]

export const HOW_WE_WORK: ReadonlyArray<{ step: string; text: string }> = [
  { step: 'Assess', text: 'We visit the villa, read its rooms, prices and running costs, and tell you what we would change.' },
  { step: 'Set up', text: 'We list the rooms, load prices and stay rules, and train or hire the villa team.' },
  { step: 'Operate', text: 'Our team hosts guests and handles housekeeping, repairs and purchasing every day.' },
  { step: 'Report', text: 'Each month you get a statement and a payout, and the owner portal shows the numbers as they land.' },
]

const NUMBER_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
export const numberWord = (n: number) => NUMBER_WORD[n] ?? String(n)

/** "Canggu, Ubud and Seminyak". */
export const listWords = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)
