import type { KpiItem } from '@/domain/people'

export interface AnnouncementSeed {
  id: string
  title: string
  body: string
  daysAgo: number
  by: string
  pinned: boolean
  villaId: string | null
}

export const ANNOUNCEMENTS: readonly AnnouncementSeed[] = [
  { id: 'ann-1', title: 'Payslips for last month are published', body: 'Open Employee area › Payslips to download yours. Questions about deductions go to Ida Bagus Rai before the 10th.', daysAgo: 3, by: 'Nia Kusuma', pinned: true, villaId: null },
  { id: 'ann-2', title: 'Galungan and Kuningan roster', body: 'Half the team is off on each of the two holy days. Managers publish the roster by Friday; swap with a colleague through your manager, not in the group chat.', daysAgo: 6, by: 'Kadek Ariani', pinned: false, villaId: null },
  { id: 'ann-3', title: 'Pool pump replacement at Villa Saka', body: 'SK-03 stays blocked until the new pump is in. Housekeeping: keep the garden hose off the pump room floor.', daysAgo: 4, by: 'Kadek Ariani', pinned: false, villaId: 'vil-saka' },
  { id: 'ann-4', title: 'New uniform fitting', body: 'The tailor visits Villa Tirta on Thursday, 09:00 to 11:00, and Villa Karang on Friday. Bring your old shirt for the size.', daysAgo: 1, by: 'Nia Kusuma', pinned: false, villaId: null },
]

export interface KpiSeed {
  employeeId: string
  /** Quarters before the current one: 0 is the current quarter. */
  quartersAgo: number
  items: readonly KpiItem[]
  status: 'draft' | 'published'
  reviewer: string
  note: string
}

const guest = (actual: number): KpiItem => ({ name: 'Guest review score', target: 4.7, actual, weight: 40, unit: '/5' })
const turnover = (actual: number): KpiItem => ({ name: 'Rooms turned over on time', target: 95, actual, weight: 30, unit: '%' })
const attendance = (actual: number): KpiItem => ({ name: 'Attendance', target: 98, actual, weight: 30, unit: '%' })
const occupancy = (actual: number): KpiItem => ({ name: 'Occupancy of the villa', target: 72, actual, weight: 40, unit: '%' })
const cost = (actual: number): KpiItem => ({ name: 'Expenses within budget', target: 100, actual, weight: 30, unit: '%' })
const tickets = (actual: number): KpiItem => ({ name: 'Requests closed within 2 hours', target: 90, actual, weight: 40, unit: '%' })

export const KPIS: readonly KpiSeed[] = [
  { employeeId: 'emp-001', quartersAgo: 1, items: [occupancy(76), cost(97), attendance(100)], status: 'published', reviewer: 'Arya Santoso', note: 'Strong quarter; keep the Lumbung expenses in line.' },
  { employeeId: 'emp-001', quartersAgo: 0, items: [occupancy(71), cost(102), attendance(100)], status: 'draft', reviewer: 'Arya Santoso', note: '' },
  { employeeId: 'emp-002', quartersAgo: 1, items: [guest(4.8), tickets(92), attendance(99)], status: 'published', reviewer: 'Kadek Ariani', note: 'Guests mention Wayan by name in reviews.' },
  { employeeId: 'emp-002', quartersAgo: 0, items: [guest(4.75), tickets(88), attendance(100)], status: 'published', reviewer: 'Kadek Ariani', note: '' },
  { employeeId: 'emp-003', quartersAgo: 1, items: [turnover(97), guest(4.6), attendance(96)], status: 'published', reviewer: 'Kadek Ariani', note: '' },
  { employeeId: 'emp-003', quartersAgo: 0, items: [turnover(93), guest(4.7), attendance(98)], status: 'published', reviewer: 'Kadek Ariani', note: 'Two late turnovers in the festival week.' },
  { employeeId: 'emp-004', quartersAgo: 0, items: [tickets(95), cost(94), attendance(100)], status: 'published', reviewer: 'Kadek Ariani', note: '' },
  { employeeId: 'emp-006', quartersAgo: 0, items: [guest(4.9), tickets(91), attendance(97)], status: 'published', reviewer: 'Putu Eka Wijaya', note: '' },
  { employeeId: 'emp-007', quartersAgo: 0, items: [turnover(98), guest(4.8), attendance(100)], status: 'published', reviewer: 'Putu Eka Wijaya', note: '' },
  { employeeId: 'emp-008', quartersAgo: 0, items: [occupancy(79), cost(99), attendance(100)], status: 'draft', reviewer: 'Arya Santoso', note: '' },
  { employeeId: 'emp-011', quartersAgo: 0, items: [guest(4.6), tickets(82), attendance(94)], status: 'published', reviewer: 'Nia Kusuma', note: 'Response time slipped while short-staffed.' },
  { employeeId: 'emp-012', quartersAgo: 0, items: [turnover(96), guest(4.7), attendance(99)], status: 'published', reviewer: 'Nia Kusuma', note: '' },
]
