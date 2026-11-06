import { COUNTRY_OPTIONS, ID_TYPE_LABEL, ID_TYPES, SEX_LABEL, VISA_TYPE_LABEL, VISA_TYPES, type IdType, type Sex, type TravelDocument, type VisaType } from '@/domain/guest'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'

/** Country picker over the ISO codes the guest record stores. */
export function CountrySelect({ id, name, defaultValue, value, onChange }: { id: string; name?: string; defaultValue?: string; value?: string; onChange?: (code: string) => void }) {
  return <Select id={id} name={name} className="w-full" {...(value !== undefined ? { value } : { defaultValue: defaultValue || '' })} onChange={(e) => onChange?.(e.target.value)} options={[{ value: '', label: 'Pick a country' }, ...COUNTRY_OPTIONS]} />
}

const day = (f: FormData, key: string) => String(f.get(key) ?? '') || null

/** The Immigration fields as the form posted them, under `prefix`. */
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

/**
 * Nationality, document, birth and entry fields for a guest or a companion. Immigration needs them for
 * foreign guests; Indonesians need the nationality and a KTP only.
 */
export function DocumentFields({ doc, prefix = '', errors = {} }: { doc?: Partial<TravelDocument>; prefix?: string; errors?: Record<string, string> }) {
  const id = (k: string) => `${prefix || 'd-'}${k}`
  const name = (k: string) => `${prefix}${k}`
  return (
    <>
      <Field label="Nationality" htmlFor={id('nat')} error={errors.nationality}>
        <CountrySelect id={id('nat')} name={name('nationality')} defaultValue={doc?.nationality} />
      </Field>
      <Field label="Document" htmlFor={id('idtype')}>
        <Select id={id('idtype')} name={name('idType')} className="w-full" defaultValue={doc?.idType ?? 'passport'} options={ID_TYPES.map((t) => ({ value: t, label: ID_TYPE_LABEL[t] }))} />
      </Field>
      <Field label="Document number" htmlFor={id('idno')}>
        <Input id={id('idno')} name={name('idNumber')} defaultValue={doc?.idNumber} className="font-mono" />
      </Field>
      <Field label="Document expiry" htmlFor={id('exp')} error={errors.idExpiry}>
        <Input id={id('exp')} name={name('idExpiry')} type="date" defaultValue={doc?.idExpiry ?? ''} />
      </Field>
      <Field label="Date of birth" htmlFor={id('dob')} error={errors.birthDate}>
        <Input id={id('dob')} name={name('birthDate')} type="date" defaultValue={doc?.birthDate ?? ''} />
      </Field>
      <Field label="Sex" htmlFor={id('sex')}>
        <Select id={id('sex')} name={name('sex')} className="w-full" defaultValue={doc?.sex ?? ''} options={[{ value: '', label: 'Not given' }, ...(['male', 'female'] as const).map((v) => ({ value: v, label: SEX_LABEL[v] }))]} />
      </Field>
      <Field label="Place of birth" htmlFor={id('pob')} hint="Optional">
        <Input id={id('pob')} name={name('birthPlace')} defaultValue={doc?.birthPlace} />
      </Field>
      <Field label="Visa type" htmlFor={id('visa')}>
        <Select id={id('visa')} name={name('visaType')} className="w-full" defaultValue={doc?.visaType ?? ''} options={[{ value: '', label: 'None, Indonesian' }, ...VISA_TYPES.map((v) => ({ value: v, label: VISA_TYPE_LABEL[v] }))]} />
      </Field>
      <Field label="Date of entry to Indonesia" htmlFor={id('entry')} error={errors.entryDate}>
        <Input id={id('entry')} name={name('entryDate')} type="date" defaultValue={doc?.entryDate ?? ''} />
      </Field>
      <Field label="Port of entry" htmlFor={id('port')}>
        <Input id={id('port')} name={name('entryPort')} defaultValue={doc?.entryPort} placeholder="Ngurah Rai (DPS)" />
      </Field>
      <Field label="Address in Indonesia" htmlFor={id('addr')} hint="Leave empty for the villa of the stay" className="sm:col-span-2">
        <Input id={id('addr')} name={name('addressInIndonesia')} defaultValue={doc?.addressInIndonesia} />
      </Field>
    </>
  )
}
