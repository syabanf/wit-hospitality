import type { TransactionKind, TransactionOrigin } from './finance'

/** A receipt, invoice, photo or transfer slip kept as proof on a ledger entry, an expense or a payment. */
export interface Attachment {
  id: string
  name: string
  /** MIME type: an image or a PDF. */
  type: string
  /** Bytes. */
  size: number
  /** Where the file opens; empty for files recorded before uploads, which keep only their name. */
  url: string
  uploadedBy: string
  /** ISO date-time. */
  uploadedAt: string
}

/** A file picked on the device, before it is stored. */
export interface UploadFile {
  name: string
  type: string
  size: number
  data: Blob
}

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
export const ATTACHMENT_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
/** What the file picker offers. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_TYPES.join(',')

export const isImage = (a: Pick<Attachment, 'type'>) => a.type.startsWith('image/')
export const isPdf = (a: Pick<Attachment, 'type'>) => a.type === 'application/pdf'

/** Why a file cannot be stored, as an API error code and a sentence, or null when it can. */
export function uploadProblem(file: Pick<UploadFile, 'name' | 'type' | 'size'>): { code: string; message: string } | null {
  if (!ATTACHMENT_TYPES.includes(file.type)) return { code: 'ATTACHMENT_TYPE', message: `${file.name} is not a photo or a PDF.` }
  if (file.size <= 0) return { code: 'ATTACHMENT_EMPTY', message: `${file.name} is empty.` }
  if (file.size > MAX_ATTACHMENT_BYTES) return { code: 'ATTACHMENT_SIZE', message: `${file.name} is over 5 MB.` }
  return null
}

/** Cash-outs at or above the threshold need at least one attachment before they go for approval; 0 switches the rule off. */
export interface ProofPolicy {
  threshold: number
}

export const DEFAULT_PROOF_POLICY: ProofPolicy = { threshold: 1_000_000 }

/** Expenses a person writes by hand; payments, refunds, payroll and transfers carry their own paper trail. */
const HAND_WRITTEN: readonly TransactionOrigin[] = ['manual', 'maintenance', 'stock']

/** A hand-written cash-out at or above the threshold needs proof; from petty cash, every one does while the rule is on. */
export function needsProof(t: { kind: TransactionKind; amount: number; origin: TransactionOrigin; attachments: readonly unknown[] }, policy: ProofPolicy, pettyCash = false) {
  return policy.threshold > 0 && t.kind === 'cash_out' && HAND_WRITTEN.includes(t.origin) && (pettyCash || t.amount >= policy.threshold) && t.attachments.length === 0
}

export function validateProofPolicy(p: ProofPolicy): Partial<Record<keyof ProofPolicy, string>> {
  return Number.isInteger(p.threshold) && p.threshold >= 0 ? {} : { threshold: 'Enter a whole rupiah amount, or 0 to switch the rule off.' }
}

const KB = 1024
export const fileSize = (bytes: number) => (bytes < KB ? `${bytes} B` : bytes < KB * KB ? `${Math.round(bytes / KB)} KB` : `${(bytes / KB / KB).toFixed(1)} MB`)

/** A seeded file: name only, typed from its extension. */
export function namedFile(name: string, uploadedBy: string, uploadedAt: string): Attachment {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const type = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg'
  return { id: `file-${name}`, name, type, size: 0, url: '', uploadedBy, uploadedAt }
}
