import type { Attachment } from '@/domain/attachment'
import type { MenuCategory, MenuItem, OrderStatus, PriceUnit, ServicePartner } from '@/domain/serviceOrder'

export const PARTNERS: readonly ServicePartner[] = [
  { id: 'ptn-taksu-spa', name: 'Taksu Mobile Spa', kind: 'spa', contact: 'Ni Luh Sari', phone: '+62 812 3755 2810', active: true },
  { id: 'ptn-hidden-bali', name: 'Hidden Bali Tours', kind: 'tours', contact: 'Gede Putra', phone: '+62 813 3820 6614', active: true },
  { id: 'ptn-dewata-driver', name: 'Dewata Drivers', kind: 'transport', contact: 'Komang Adi', phone: '+62 878 6011 4402', active: true },
]

const h = (hour: number, minute = 0) => hour * 60 + minute
const DAY = { from: 0, to: 24 * 60 - 1 }

interface ItemSeed {
  slug: string
  category: MenuCategory
  name: string
  description: string
  price: number
  unit: PriceUnit
  from: number
  to: number
  lead: number
  partnerId?: string
  cost?: number
  /** Borrows another item's illustration from public/menu. */
  art?: string
}

/** One menu card; each villa gets its own copy so prices and availability can differ per villa. */
const CARD: readonly ItemSeed[] = [
  { slug: 'breakfast-bali', category: 'breakfast', name: 'Balinese breakfast', description: 'Nasi goreng or bubur ayam, tropical fruit, Kintamani coffee or tea.', price: 120_000, unit: 'person', from: h(6, 30), to: h(10, 30), lead: 30 },
  { slug: 'breakfast-continental', category: 'breakfast', name: 'Continental breakfast', description: 'Eggs your way, toast, granola bowl, juice and coffee.', price: 135_000, unit: 'person', from: h(6, 30), to: h(10, 30), lead: 30 },
  { slug: 'breakfast-floating', category: 'breakfast', name: 'Floating breakfast', description: 'Breakfast for two served on a tray in your pool, with flowers.', price: 450_000, unit: 'item', from: h(7), to: h(10), lead: 12 * 60 },
  { slug: 'nasi-goreng', category: 'food', name: 'Nasi goreng ayam', description: 'Fried rice with chicken satay, egg and krupuk.', price: 75_000, unit: 'item', from: h(10), to: h(22), lead: 30 },
  { slug: 'mie-goreng', category: 'food', name: 'Mie goreng seafood', description: 'Fried noodles with prawns and squid.', price: 85_000, unit: 'item', from: h(10), to: h(22), lead: 30 },
  { slug: 'babi-guling', category: 'food', name: 'Babi guling plate', description: 'Balinese roast pork with lawar and rice.', price: 110_000, unit: 'item', from: h(11), to: h(21), lead: 45 },
  { slug: 'bbq-dinner', category: 'food', name: 'Seafood BBQ dinner for two', description: 'Grilled snapper, prawns and squid by the pool, with sides and sambal.', price: 950_000, unit: 'item', from: h(17), to: h(21), lead: 4 * 60 },
  { slug: 'coconut', category: 'food', name: 'Fresh young coconut', description: 'Chilled, opened at your door.', price: 35_000, unit: 'item', from: h(8), to: h(20), lead: 15 },
  { slug: 'bintang', category: 'minibar', name: 'Bintang large', description: '620 ml bottle, cold.', price: 55_000, unit: 'item', ...DAY, lead: 15 },
  { slug: 'water', category: 'minibar', name: 'Mineral water 1.5 L', description: 'Aqua, cold.', price: 20_000, unit: 'item', ...DAY, lead: 15 },
  { slug: 'bintang-small', category: 'minibar', name: 'Bintang small', description: '330 ml can, cold.', price: 40_000, unit: 'item', ...DAY, lead: 15, art: 'bintang' },
  { slug: 'sparkling', category: 'minibar', name: 'Sparkling water', description: '500 ml bottle.', price: 30_000, unit: 'item', ...DAY, lead: 15, art: 'water' },
  { slug: 'cola', category: 'minibar', name: 'Coca-Cola', description: '330 ml can.', price: 25_000, unit: 'item', ...DAY, lead: 15, art: 'water' },
  { slug: 'sprite', category: 'minibar', name: 'Sprite', description: '330 ml can.', price: 25_000, unit: 'item', ...DAY, lead: 15, art: 'water' },
  { slug: 'juice', category: 'minibar', name: 'Orange juice', description: '250 ml bottle.', price: 30_000, unit: 'item', ...DAY, lead: 15, art: 'coconut' },
  { slug: 'chips', category: 'minibar', name: 'Potato chips', description: 'Sea salt, 68 g.', price: 35_000, unit: 'item', ...DAY, lead: 15, art: 'coconut' },
  { slug: 'cashews', category: 'minibar', name: 'Roasted cashews', description: 'Salted Bali cashews, 100 g.', price: 45_000, unit: 'item', ...DAY, lead: 15, art: 'coconut' },
  { slug: 'chocolate', category: 'minibar', name: 'Dark chocolate', description: 'Single-origin Bali cacao bar.', price: 30_000, unit: 'item', ...DAY, lead: 15, art: 'coconut' },
  { slug: 'wine', category: 'minibar', name: 'Red wine, half bottle', description: '375 ml Balinese red.', price: 280_000, unit: 'item', ...DAY, lead: 15, art: 'bintang' },
  { slug: 'arak', category: 'minibar', name: 'Arak Bali', description: '150 ml, with lime and honey on the side.', price: 90_000, unit: 'item', ...DAY, lead: 15, art: 'bintang' },
  { slug: 'laundry', category: 'laundry', name: 'Wash and fold', description: 'Back the next afternoon.', price: 45_000, unit: 'kg', from: h(8), to: h(18), lead: 0 },
  { slug: 'laundry-express', category: 'laundry', name: 'Express laundry', description: 'Back the same evening when collected before 11:00.', price: 75_000, unit: 'kg', from: h(8), to: h(11), lead: 0 },
  { slug: 'airport', category: 'transport', name: 'Airport transfer', description: 'Private car to or from Ngurah Rai, up to four guests and luggage.', price: 350_000, unit: 'trip', ...DAY, lead: 6 * 60, partnerId: 'ptn-dewata-driver', cost: 250_000 },
  { slug: 'driver-day', category: 'transport', name: 'Driver for the day', description: 'Car and driver for ten hours, fuel included.', price: 750_000, unit: 'trip', from: h(7), to: h(10), lead: 12 * 60, partnerId: 'ptn-dewata-driver', cost: 600_000 },
  { slug: 'massage', category: 'spa', name: 'Balinese massage, 60 minutes', description: 'In your villa, with coconut oil.', price: 300_000, unit: 'person', from: h(9), to: h(21), lead: 2 * 60, partnerId: 'ptn-taksu-spa', cost: 180_000 },
  { slug: 'massage-couple', category: 'spa', name: 'Couple massage, 90 minutes', description: 'Two therapists, flower bath to finish.', price: 850_000, unit: 'item', from: h(9), to: h(20), lead: 3 * 60, partnerId: 'ptn-taksu-spa', cost: 520_000 },
  { slug: 'ubud-tour', category: 'tours', name: 'Ubud rice terraces and temples', description: 'Tegallalang, Tirta Empul and lunch, hotel pickup.', price: 650_000, unit: 'person', from: h(7), to: h(9), lead: 24 * 60, partnerId: 'ptn-hidden-bali', cost: 450_000 },
  { slug: 'batur', category: 'tours', name: 'Mount Batur sunrise trek', description: 'Pickup at 02:00, guide, breakfast at the top.', price: 900_000, unit: 'person', from: h(1, 30), to: h(2, 30), lead: 24 * 60, partnerId: 'ptn-hidden-bali', cost: 650_000 },
  { slug: 'kecak', category: 'tours', name: 'Uluwatu Kecak fire dance', description: 'Ticket and return transport, sunset at the temple.', price: 400_000, unit: 'person', from: h(16), to: h(17), lead: 4 * 60, partnerId: 'ptn-hidden-bali', cost: 280_000 },
  { slug: 'extra-bed', category: 'extras', name: 'Extra bed', description: 'Made up with linen, per night.', price: 250_000, unit: 'item', from: h(10), to: h(20), lead: 2 * 60 },
  { slug: 'baby-cot', category: 'extras', name: 'Baby cot', description: 'With linen, per stay.', price: 100_000, unit: 'item', from: h(8), to: h(20), lead: 60 },
  { slug: 'decoration', category: 'extras', name: 'Birthday or honeymoon decoration', description: 'Flowers, towel art and a small cake.', price: 450_000, unit: 'item', from: h(10), to: h(18), lead: 8 * 60 },
  { slug: 'extra-clean', category: 'housekeeping', name: 'Extra cleaning', description: 'A full clean and fresh towels mid-stay.', price: 150_000, unit: 'item', from: h(9), to: h(17), lead: 60 },
  { slug: 'late-checkout', category: 'housekeeping', name: 'Late check-out until 16:00', description: 'Subject to the next arrival; we confirm by message.', price: 500_000, unit: 'item', from: h(7), to: h(11), lead: 0 },
]

const VILLA_CODES: ReadonlyArray<{ villaId: string; code: string; skip?: readonly string[] }> = [
  { villaId: 'vil-saka', code: 'sk', skip: ['kecak'] },
  { villaId: 'vil-tirta', code: 'tr', skip: ['kecak', 'breakfast-floating'] },
  { villaId: 'vil-lumbung', code: 'lb', skip: ['batur'] },
  { villaId: 'vil-karang', code: 'kr' },
  { villaId: 'vil-pandawa', code: 'pd' },
]

/** Illustrations shipped in public/menu, one per card item; staff replace them with real photos from the menu page. */
const menuArt = (slug: string, itemId: string): Attachment => ({
  id: `att-${itemId}`,
  name: `${slug}.svg`,
  type: 'image/svg+xml',
  size: 4_000,
  url: `/menu/${slug}.svg`,
  uploadedBy: 'Villa Console',
  uploadedAt: '2026-10-01T08:00:00+08:00',
})

export const MENU: readonly MenuItem[] = VILLA_CODES.flatMap(({ villaId, code, skip = [] }) =>
  CARD.filter((i) => !skip.includes(i.slug)).map((i) => ({
    id: `mi-${code}-${i.slug}`,
    villaId,
    category: i.category,
    name: i.name,
    description: i.description,
    photo: menuArt(i.art ?? i.slug, `mi-${code}-${i.slug}`),
    price: i.price,
    unit: i.unit,
    availableFrom: i.from,
    availableTo: i.to,
    leadMinutes: i.lead,
    active: !(code === 'tr' && i.slug === 'babi-guling'),
    partnerId: i.partnerId ?? null,
    costPrice: i.cost ?? 0,
  })),
)

export interface OrderSeed {
  seq: number
  /** Which in-house stay, by position in the list of stays checked in today. */
  stay: number
  lines: ReadonlyArray<{ slug: string; quantity: number; comp?: boolean }>
  status: OrderStatus
  daysAgo: number
  at: number
  placedBy: 'guest' | 'staff'
  note: string
  assignee: string
  /** Delivered orders only: how the guest settled, or null while unpaid. */
  paid: 'cash' | 'qris' | null
  priority?: 'urgent'
  compReason?: string
  discountPct?: number
  discountReason?: string
}

/** A morning of orders across the in-house stays: some to accept, some cooking, some delivered and paid. */
export const ORDER_SEEDS: readonly OrderSeed[] = [
  { seq: 1, stay: 0, lines: [{ slug: 'breakfast-bali', quantity: 2 }, { slug: 'coconut', quantity: 2 }], status: 'delivered', daysAgo: 1, at: h(8), placedBy: 'guest', note: 'One without chilli please', assignee: 'Wayan', paid: 'cash' },
  { seq: 2, stay: 1, lines: [{ slug: 'massage', quantity: 2 }], status: 'delivered', daysAgo: 1, at: h(16), placedBy: 'staff', note: 'On the terrace', assignee: 'Taksu Mobile Spa', paid: null },
  { seq: 3, stay: 2, lines: [{ slug: 'laundry', quantity: 3.5 }], status: 'delivered', daysAgo: 1, at: h(10), placedBy: 'guest', note: '', assignee: 'Komang', paid: 'qris' },
  { seq: 4, stay: 0, lines: [{ slug: 'airport', quantity: 1 }], status: 'confirmed', daysAgo: -1, at: h(10), placedBy: 'staff', note: 'Flight QZ 507, three suitcases', assignee: 'Dewata Drivers', paid: null },
  { seq: 5, stay: 3, lines: [{ slug: 'nasi-goreng', quantity: 1 }, { slug: 'bintang', quantity: 2 }], status: 'preparing', daysAgo: 0, at: h(12, 30), placedBy: 'guest', note: '', assignee: 'Wayan', paid: null },
  { seq: 6, stay: 1, lines: [{ slug: 'breakfast-continental', quantity: 2 }], status: 'new', daysAgo: -1, at: h(8), placedBy: 'guest', note: 'Eggs scrambled', assignee: '', paid: null },
  { seq: 7, stay: 4, lines: [{ slug: 'decoration', quantity: 1, comp: true }, { slug: 'bbq-dinner', quantity: 1 }], status: 'confirmed', daysAgo: -1, at: h(19), placedBy: 'staff', note: 'Anniversary surprise, do not tell the guest', assignee: 'Kadek', paid: null, compReason: 'Anniversary, returning guest' },
  { seq: 8, stay: 2, lines: [{ slug: 'ubud-tour', quantity: 2 }], status: 'delivered', daysAgo: 2, at: h(8), placedBy: 'staff', note: '', assignee: 'Hidden Bali Tours', paid: 'cash', discountPct: 10, discountReason: 'Booked two tours' },
  { seq: 9, stay: 3, lines: [{ slug: 'water', quantity: 4 }], status: 'new', daysAgo: 0, at: h(9), placedBy: 'guest', note: '', assignee: '', paid: null, priority: 'urgent' },
]
