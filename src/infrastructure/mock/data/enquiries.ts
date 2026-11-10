import type { Enquiry } from '@/domain/enquiry'
import { enquiryNumber } from '@/domain/enquiry'
import { addDays, type IsoDate } from '@/lib/dates'

interface EnquirySeed extends Omit<Enquiry, 'id' | 'number' | 'checkIn' | 'checkOut' | 'createdOn' | 'createdAt' | 'bookingId'> {
  /** Days from today the stay starts, how long it is, and how many days ago the guest wrote. */
  inDays: number
  nights: number
  sentDaysAgo: number
}

/** Four web enquiries: two new, one the team called back, one closed after the guest went elsewhere. */
const SEEDS: readonly EnquirySeed[] = [
  { name: 'Charlotte Meyer', email: 'charlotte.meyer@example.de', whatsapp: '+49 151 2234 8812', country: 'DE', guests: 2, villaId: 'vil-tirta', groupId: 'grp-tirta-pool', note: 'Honeymoon, arriving late from Singapore.', inDays: 24, nights: 5, sentDaysAgo: 0, status: 'new', handledBy: null, statusNote: '' },
  { name: 'Liam O’Connor', email: 'liam.oconnor@example.com.au', whatsapp: '+61 412 553 019', country: 'AU', guests: 4, villaId: 'vil-karang', groupId: 'grp-karang-cliff', note: 'Two couples, surfing trip. Can you arrange board racks?', inDays: 40, nights: 7, sentDaysAgo: 1, status: 'new', handledBy: null, statusNote: '' },
  { name: 'Dewi Kartika', email: 'dewi.kartika@example.co.id', whatsapp: '+62 812 4410 7732', country: 'ID', guests: 2, villaId: 'vil-saka', groupId: 'grp-saka-standard', note: 'Weekend away, would like breakfast in the villa.', inDays: 10, nights: 2, sentDaysAgo: 2, status: 'contacted', handledBy: 'Dian Permata', statusNote: 'Sent the rate on WhatsApp, waiting for her dates to firm up.' },
  { name: 'Tom Hughes', email: 'tom.hughes@example.co.uk', whatsapp: '+44 7700 900 412', country: 'GB', guests: 2, villaId: 'vil-lumbung', groupId: null, note: '', inDays: 15, nights: 3, sentDaysAgo: 6, status: 'closed', handledBy: 'Dian Permata', statusNote: 'Booked elsewhere.' },
]

export function seedEnquiries(today: IsoDate): Enquiry[] {
  return SEEDS.map(({ inDays, nights, sentDaysAgo, ...e }, i) => {
    const createdOn = addDays(today, -sentDaysAgo)
    return { ...e, id: `enq-${i + 1}`, number: enquiryNumber(i + 1), checkIn: addDays(today, inDays), checkOut: addDays(today, inDays + nights), bookingId: null, createdOn, createdAt: `${createdOn}T${String(8 + i * 3).padStart(2, '0')}:15:00` }
  })
}
