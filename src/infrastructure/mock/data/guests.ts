import type { IdType } from '@/domain/guest'

export interface GuestSeed {
  id: string
  name: string
  email: string
  phone: string
  nationality: string
  idType: IdType
  idNumber: string
  notes: string
  createdDaysAgo: number
}

const guest = (n: number, name: string, nationality: string, phone: string, idType: IdType, idNumber: string, createdDaysAgo: number, notes = ''): GuestSeed => ({
  id: `g-${String(n).padStart(2, '0')}`,
  name,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`,
  phone,
  nationality,
  idType,
  idNumber,
  notes,
  createdDaysAgo,
})

export const GUESTS: readonly GuestSeed[] = [
  guest(1, 'Hannah Weiss', 'Germany', '+49 170 2231 884', 'passport', 'C7K2L9X41', 140, 'Prefers a quiet unit away from the pool pump.'),
  guest(2, "Liam O'Connor", 'Ireland', '+353 86 221 0934', 'passport', 'PX8821043', 131),
  guest(3, 'Putri Anjani', 'Indonesia', '+62 812 3344 5566', 'ktp', '5171024503920002', 126, 'Returning guest, books for family weekends.'),
  guest(4, 'Sato Yuki', 'Japan', '+81 90 1122 3344', 'passport', 'TK4471182', 122),
  guest(5, 'Mateo Álvarez', 'Spain', '+34 612 445 778', 'passport', 'XDA442110', 118),
  guest(6, 'Chloe Martin', 'France', '+33 6 12 34 56 78', 'passport', '19FV55213', 115),
  guest(7, 'Ravi Menon', 'India', '+91 98450 12345', 'passport', 'N8812345', 110),
  guest(8, 'Emma Lindqvist', 'Sweden', '+46 70 123 45 67', 'passport', '88123456', 104),
  guest(9, 'Daniel Park', 'South Korea', '+82 10 2345 6789', 'passport', 'M12345678', 101),
  guest(10, 'Olivia Brown', 'Australia', '+61 412 345 678', 'passport', 'PA1234567', 98, 'Surf trips, asks for early board storage.'),
  guest(11, 'Budi Santoso', 'Indonesia', '+62 813 9988 7766', 'ktp', '3171012209880001', 95),
  guest(12, 'Nadia Rahman', 'Malaysia', '+60 12 345 6789', 'passport', 'A12345678', 90),
  guest(13, 'Lucas Ferreira', 'Brazil', '+55 11 91234 5678', 'passport', 'FP123456', 86),
  guest(14, 'Mia Tan', 'Singapore', '+65 9123 4567', 'passport', 'E1234567K', 80),
  guest(15, 'Jonas Becker', 'Germany', '+49 151 2345 6789', 'passport', 'C01X2Y3Z4', 77),
  guest(16, 'Sarah Cohen', 'United States', '+1 415 555 0134', 'passport', '541234567', 74),
  guest(17, 'Wei Zhang', 'China', '+86 138 0013 8000', 'passport', 'E12345678', 69),
  guest(18, 'Isabella Rossi', 'Italy', '+39 320 123 4567', 'passport', 'YA1234567', 63),
  guest(19, 'Noah Williams', 'United Kingdom', '+44 7700 900123', 'passport', '123456789', 58),
  guest(20, 'Ayu Lestari', 'Indonesia', '+62 811 2233 4455', 'ktp', '5103014107950003', 52),
  guest(21, 'Felix Andersen', 'Denmark', '+45 20 12 34 56', 'passport', '200123456', 47),
  guest(22, 'Amara Okafor', 'Nigeria', '+234 803 123 4567', 'passport', 'A01234567', 40),
  guest(23, 'Thomas Dubois', 'France', '+33 7 98 76 54 32', 'passport', '21AB11223', 33),
  guest(24, 'Grace Kim', 'United States', '+1 212 555 0199', 'passport', '598765432', 21),
]
