import type { IdType, Sex, TravelDocument, VisaType } from '@/domain/guest'

const day = (f: FormData, key: string) => String(f.get(key) ?? '') || null

/** The Immigration fields as DocumentFields posted them, under `prefix`. */
export function readDocument(f: FormData, prefix = ''): TravelDocument {
  return {
    nationality: String(f.get(`${prefix}nationality`) ?? ''),
    idType: (f.get(`${prefix}idType`) as IdType | null) ?? 'passport',
    idNumber: String(f.get(`${prefix}idNumber`) ?? ''),
    idExpiry: day(f, `${prefix}idExpiry`),
    birthDate: day(f, `${prefix}birthDate`),
    sex: (String(f.get(`${prefix}sex`) ?? '') || null) as Sex | null,
    birthPlace: String(f.get(`${prefix}birthPlace`) ?? ''),
    entryDate: day(f, `${prefix}entryDate`),
    entryPort: String(f.get(`${prefix}entryPort`) ?? ''),
    visaType: (String(f.get(`${prefix}visaType`) ?? '') || null) as VisaType | null,
    addressInIndonesia: String(f.get(`${prefix}addressInIndonesia`) ?? ''),
  }
}
