/** RFC 4180 text: every cell quoted, quotes doubled, CRLF rows, a BOM so Excel reads UTF-8. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return `﻿${[headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`
}

export const csvFileName = (base: string, date: string) => `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${date}.csv`
