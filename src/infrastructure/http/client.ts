import { RuleError } from '@/domain/errors'

interface Envelope<T> {
  data: T
}
interface Problem {
  error?: { code?: string; message?: string }
}

export interface HttpClientOptions {
  /** How many times a write is sent again after a network failure or a 502/504. */
  retries?: number
  /** Wait before the first resend; each later resend waits one step longer. */
  retryDelayMs?: number
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const GATEWAY_FAILURES = new Set([502, 504])

/** A random Idempotency-Key. getRandomValues works on plain http too, unlike randomUUID. */
function newKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * JSON client for the `/api/v1` contract: success arrives as `{ data }`, failure as
 * `{ error: { code, message } }`. The code becomes a RuleError so pages show the reason.
 *
 * Each write call is one user action and carries a fresh Idempotency-Key. When the network drops
 * or the gateway answers 502/504, the client sends the same write again with the same key, so the
 * API replays its first answer instead of booking twice. Uploads go without a key, since the API
 * buffers keyed bodies only up to 1 MiB, and so do `auth/` calls, since a replay carries no cookies.
 */
export function createHttpClient(baseUrl: string, options: HttpClientOptions = {}) {
  // A path such as /api/v1 means the API sits behind the page's own origin (the nginx image).
  const root = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`, globalThis.location?.href)
  const retries = options.retries ?? 2
  const retryDelayMs = options.retryDelayMs ?? 300

  async function send(path: string, init: RequestInit | undefined): Promise<Response> {
    const upload = init?.body instanceof FormData
    const key = WRITES.has(init?.method ?? 'GET') && !upload && !path.startsWith('auth/') ? newKey() : undefined
    const headers: Record<string, string> = upload ? {} : { 'content-type': 'application/json' }
    if (key) headers['idempotency-key'] = key
    for (let attempt = 0; ; attempt++) {
      const last = !key || attempt >= retries
      try {
        const res = await fetch(new URL(path, root), { credentials: 'include', ...init, headers })
        if (last || !GATEWAY_FAILURES.has(res.status)) return res
      } catch (err) {
        if (last) throw err
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)))
    }
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await send(path, init)
    if (!res.ok) {
      const problem = (await res.json().catch(() => null)) as Problem | null
      throw new RuleError(problem?.error?.code ?? `HTTP_${res.status}`, problem?.error?.message ?? `${res.status} ${res.statusText} on ${path}`)
    }
    if (res.status === 204) return undefined as T
    return ((await res.json()) as Envelope<T>).data
  }
  const body = (value: unknown) => JSON.stringify(value)
  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, value: unknown = {}) => request<T>(path, { method: 'POST', body: body(value) }),
    patch: <T>(path: string, value: unknown) => request<T>(path, { method: 'PATCH', body: body(value) }),
    put: <T>(path: string, value: unknown) => request<T>(path, { method: 'PUT', body: body(value) }),
    delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
    /** Multipart upload; the browser sets the boundary header. */
    upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  }
}
