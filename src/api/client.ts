import { endSession, getAccessToken, hasStoredSession, refreshSession, toEndReason } from '../auth/session'
import { API_BASE_URL, baseHeaders } from './config'
import { ApiError, toApiError } from './errors'

export interface ApiInit extends Omit<RequestInit, 'body'> {
  /** Cuerpo a serializar como JSON. */
  json?: unknown
  /** false para rutas públicas (login, register, health). Por defecto true. */
  auth?: boolean
}

export interface ApiResponse<T> {
  data: T
  status: number
  headers: Headers
}

function send(path: string, init: ApiInit, token: string | null): Promise<Response> {
  const headers = baseHeaders()
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  let body: string | undefined
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(init.json)
  }
  const { json: _json, auth: _auth, ...rest } = init
  return fetch(`${API_BASE_URL}${path}`, { ...rest, headers, body })
}

/**
 * fetch con sesión. Si la respuesta es 401 TOKEN_EXPIRED, hace refresh (compartido) y
 * reintenta UNA sola vez. Cualquier otro 401 cierra la sesión.
 * Devuelve data + headers (útil para ETag, Retry-After, Idempotent-Replayed...).
 */
export async function apiRequest<T>(path: string, init: ApiInit = {}): Promise<ApiResponse<T>> {
  const useAuth = init.auth ?? true
  let token = useAuth ? getAccessToken() : null
  if (useAuth && token === null && hasStoredSession()) token = await refreshSession(null)

  let res = await send(path, init, token)

  if (!res.ok) {
    const err = await toApiError(res)
    if (useAuth && res.status === 401) {
      if (err.code !== 'TOKEN_EXPIRED') {
        endSession(toEndReason(err.code))
        throw err
      }
      const fresh = await refreshSession(token)
      res = await send(path, init, fresh) // único reintento
      if (!res.ok) {
        const retryErr = await toApiError(res)
        if (res.status === 401 && retryErr.code !== 'TOKEN_EXPIRED') endSession(toEndReason(retryErr.code))
        throw retryErr
      }
    } else {
      throw err
    }
  }

  const data = (res.status === 204 ? undefined : await res.json()) as T
  return { data, status: res.status, headers: res.headers }
}

export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  return (await apiRequest<T>(path, init)).data
}

export { ApiError }
