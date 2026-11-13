import type { UploadFile } from '@/domain/attachment'

/**
 * Phone photos run to several MB; this keeps them readable at a fraction of the size. Files under
 * `minBytes`, and types the canvas cannot re-encode, go as they are.
 */
export async function shrink(file: File, maxEdge = 1600, minBytes = 400_000): Promise<UploadFile> {
  const raw = { name: file.name, type: file.type, size: file.size, data: file }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < minBytes) return raw
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.8))
    if (!blob || blob.size >= file.size) return raw
    return { name: file.name.replace(/\.\w+$/, '.jpg'), type: 'image/jpeg', size: blob.size, data: blob }
  } catch {
    return raw
  }
}
