import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from './client'

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } })
}

function keyOf(call: unknown[]): string | undefined {
  return ((call[1] as RequestInit).headers as Record<string, string>)['idempotency-key']
}

describe('http client Idempotency-Key', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends a fresh key on each write and none on reads', async () => {
    const fetch = vi.fn(async () => ok({ id: 'b-1' }))
    vi.stubGlobal('fetch', fetch)
    const http = createHttpClient('http://api/api/v1')
    await http.post('bookings', { unitId: 'u-1' })
    await http.post('bookings', { unitId: 'u-1' })
    await http.patch('bookings/b-1', { notes: '' })
    await http.delete('unit-blocks/x')
    await http.get('bookings')
    const keys = fetch.mock.calls.map(keyOf)
    expect(keys.slice(0, 4).every((k) => typeof k === 'string' && k.length === 32)).toBe(true)
    expect(new Set(keys.slice(0, 4)).size).toBe(4)
    expect(keys[4]).toBeUndefined()
  })

  it('resends the same write with the same key after a network failure or a gateway error', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(ok({ id: 'b-1' }, 201))
    vi.stubGlobal('fetch', fetch)
    const http = createHttpClient('http://api/api/v1', { retryDelayMs: 0 })
    await expect(http.post('bookings', { guest: { name: 'Ayu' } })).resolves.toEqual({ id: 'b-1' })
    expect(fetch).toHaveBeenCalledTimes(3)
    const keys = fetch.mock.calls.map(keyOf)
    expect(keys[0]).toBeDefined()
    expect(new Set(keys).size).toBe(1)
  })

  it('gives up after the retries and does not resend a rule refusal', async () => {
    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', down)
    const http = createHttpClient('http://api/api/v1', { retries: 2, retryDelayMs: 0 })
    await expect(http.put('bookings/b-1/price', {})).rejects.toThrow('Failed to fetch')
    expect(down).toHaveBeenCalledTimes(3)

    const refused = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'BOOKING_OVERLAP', message: 'Taken.' } }), { status: 409 }))
    vi.stubGlobal('fetch', refused)
    await expect(http.post('bookings', {})).rejects.toMatchObject({ code: 'BOOKING_OVERLAP' })
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('leaves reads, uploads and sign-in without a key and does not resend them', async () => {
    const down = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', down)
    const http = createHttpClient('http://api/api/v1', { retryDelayMs: 0 })
    await expect(http.get('bookings')).rejects.toThrow()
    await expect(http.upload('files', new FormData())).rejects.toThrow()
    await expect(http.post('auth/login', { email: 'a', password: 'b' })).rejects.toThrow()
    expect(down).toHaveBeenCalledTimes(3)
    expect(down.mock.calls.map(keyOf)).toEqual([undefined, undefined, undefined])
  })
})

describe('http client base URL', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves a path base against the page origin', async () => {
    const fetch = vi.fn(async () => ok([]))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('location', { href: 'http://console.test/bookings' })
    await createHttpClient('/api/v1').get('bookings')
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('http://console.test/api/v1/bookings')
  })
})
