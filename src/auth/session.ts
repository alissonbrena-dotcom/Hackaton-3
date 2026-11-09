import { API_BASE_URL, baseHeaders } from '../api/config'
import { ApiError, toApiError } from '../api/errors'
import type { TokenPair } from '../api/types'

/**
 * Manejo de tokens.
 *
 * - accessToken: SOLO en memoria (esta variable). Nunca en localStorage/sessionStorage/cookies,
 *   así un XSS no puede leerlo de un storage persistente.
 * - refreshToken: en localStorage, para restaurar la sesión al recargar. Es de UN SOLO USO.
 *
 * Coordinación del refresh:
 * - En la misma pestaña: una sola promesa compartida (`refreshing`). Si 5 requests reciben
 *   TOKEN_EXPIRED a la vez, las 5 esperan el MISMO POST /auth/refresh.
 * - Entre pestañas: Web Locks (`navigator.locks`). Solo una pestaña a la vez puede refrescar;
 *   las demás esperan, y al entrar leen el refresh token NUEVO de localStorage (nunca reusan uno viejo).
 *   La pestaña que refresca reparte el access token nuevo por BroadcastChannel.
 */

const REFRESH_KEY = 'lumon.refresh'
const LOCK_NAME = 'lumon-refresh'

export type EndReason = 'LOGOUT' | 'REFRESH_REUSED' | 'SESSION_REVOKED' | 'TOKEN_INVALID' | 'REFRESH_INVALID'

type Message = { type: 'access'; token: string } | { type: 'ended'; reason: EndReason }

let accessToken: string | null = null
let refreshing: Promise<string> | null = null

const channel: BroadcastChannel | null = 'BroadcastChannel' in window ? new BroadcastChannel('lumon-auth') : null
const endListeners = new Set<(reason: EndReason) => void>()
const accessListeners = new Set<() => void>()

channel?.addEventListener('message', (e: MessageEvent<Message>) => {
  const msg = e.data
  if (msg.type === 'access') {
    accessToken = msg.token
    accessListeners.forEach((fn) => fn())
  } else if (msg.type === 'ended') {
    endLocal(msg.reason)
  }
})

function readRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

function endLocal(reason: EndReason) {
  accessToken = null
  try {
    localStorage.removeItem(REFRESH_KEY)
  } catch {
    // storage bloqueado: igual cerramos en memoria
  }
  endListeners.forEach((fn) => fn(reason))
}

export function getAccessToken(): string | null {
  return accessToken
}

export function hasStoredSession(): boolean {
  return accessToken !== null || readRefresh() !== null
}

/** Guarda un par nuevo (login, registro o refresh) y avisa a las otras pestañas. */
export function startSession(pair: TokenPair) {
  accessToken = pair.accessToken
  localStorage.setItem(REFRESH_KEY, pair.refreshToken)
  channel?.postMessage({ type: 'access', token: pair.accessToken } satisfies Message)
}

/** Cierra la sesión en esta pestaña y en todas las demás. */
export function endSession(reason: EndReason) {
  endLocal(reason)
  channel?.postMessage({ type: 'ended', reason } satisfies Message)
}

export function onSessionEnd(fn: (reason: EndReason) => void): () => void {
  endListeners.add(fn)
  return () => endListeners.delete(fn)
}

/** Otra pestaña inició sesión o refrescó: aquí ya hay un access token nuevo. */
export function onAccessFromOtherTab(fn: () => void): () => void {
  accessListeners.add(fn)
  return () => accessListeners.delete(fn)
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if ('locks' in navigator) return navigator.locks.request(LOCK_NAME, fn)
  return fn()
}

/**
 * Devuelve un access token válido.
 * @param failedToken el token con el que la request recibió TOKEN_EXPIRED (null si no había).
 */
export function refreshSession(failedToken: string | null): Promise<string> {
  refreshing ??= withLock(async () => {
    // Mientras esperábamos el lock, otra pestaña (o request) pudo haber refrescado ya.
    if (accessToken !== null && accessToken !== failedToken) return accessToken

    // Se lee DENTRO del lock: siempre es el refresh token más reciente, nunca uno ya usado.
    const refreshToken = readRefresh()
    if (refreshToken === null) {
      endLocal('REFRESH_INVALID')
      throw new ApiError(401, { error: 'REFRESH_INVALID', message: 'No hay sesión guardada.', details: null }, null)
    }

    const headers = baseHeaders()
    headers.set('Content-Type', 'application/json')
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) {
      const err = await toApiError(res)
      if (res.status === 401) endSession(toEndReason(err.code))
      throw err
    }
    const pair = (await res.json()) as TokenPair
    startSession(pair)
    return pair.accessToken
  }).finally(() => {
    refreshing = null
  })
  return refreshing
}

export function toEndReason(code: string): EndReason {
  switch (code) {
    case 'REFRESH_REUSED':
    case 'SESSION_REVOKED':
    case 'REFRESH_INVALID':
      return code
    default:
      return 'TOKEN_INVALID'
  }
}

/** Logout: revoca en el servidor y cierra en todas las pestañas. */
export async function logout(): Promise<void> {
  const refreshToken = readRefresh()
  if (refreshToken !== null) {
    const headers = baseHeaders()
    headers.set('Content-Type', 'application/json')
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', headers, body: JSON.stringify({ refreshToken }) })
    } catch {
      // Sin red: igual cerramos localmente.
    }
  }
  endSession('LOGOUT')
}
