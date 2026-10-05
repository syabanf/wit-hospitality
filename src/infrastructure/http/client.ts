import { RuleError } from '@/domain/errors'

interface Envelope<T> {
  data: T
}
interface Problem {
  error?: { code?: string; message?: string }
}

/**
 * JSON client for the `/api/v1` contract: success arrives as `{ data }`, failure as
 * `{ error: { code, message } }`. The code becomes a RuleError so pages show the reason.
 */
export function createHttpClient(baseUrl: string) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(new URL(path, root), {
      credentials: 'include',
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
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
    delete: (path: string) => request<void>(path, { method: 'DELETE' }),
  }
}
