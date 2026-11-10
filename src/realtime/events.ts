import { apiRequest } from '../api/client'
import { API_BASE_URL } from '../api/config'
import { ApiError, toApiError } from '../api/errors'
import { backoffMs, sleep } from '../api/files'
import { endSession } from '../auth/session'

/**
 * Stream de eventos (SSE) del workspace.
 *
 * - Una sola conexión por navegador: las pestañas compiten por un Web Lock; la que lo tiene (líder)
 *   abre el stream y reparte cada evento a las demás por BroadcastChannel. Si la líder se cierra,
 *   el lock se libera y otra pestaña lo toma y reconecta con el último `lastEventId` conocido.
 * - Cada conexión usa un ticket nuevo (POST /events/tickets): son de un solo uso.
 * - Se lee con fetch + ReadableStream (nativo) para ver también los heartbeats (`: hb`) y detectar
 *   una conexión muerta tras 45 s sin datos.
 * - Ningún evento se aplica dos veces: se descarta por `id` ya visto.
 */

export interface LumonEvent {
  id: number | null
  type: string
  data: unknown
}

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface StatusInfo {
  status: StreamStatus
  leader: boolean
  message: string | null
}

type ChannelMsg =
  | { kind: 'event'; event: LumonEvent }
  | { kind: 'status'; info: StatusInfo }
  | { kind: 'hello' }

const LOCK = 'lumon-events-leader'
const DEAD_AFTER_MS = 45_000

const listeners = new Map<string, Set<(e: LumonEvent) => void>>()
const statusListeners = new Set<() => void>()
const seen = new Set<number>()
const seenOrder: number[] = []
let lastEventId: number | null = null
let statusInfo: StatusInfo = { status: 'idle', leader: false, message: null }
let channel: BroadcastChannel | null = null
let stopController: AbortController | null = null
let running = 0

function remember(id: number) {
  seen.add(id)
  seenOrder.push(id)
  if (seenOrder.length > 1000) seen.delete(seenOrder.shift() as number)
  if (lastEventId === null || id > lastEventId) lastEventId = id
}

/** Entrega un evento a los suscriptores de esta pestaña (una sola vez por id). */
function deliver(event: LumonEvent): boolean {
  if (event.id !== null) {
    if (seen.has(event.id)) return false
    remember(event.id)
  }
  listeners.get(event.type)?.forEach((fn) => fn(event))
  listeners.get('*')?.forEach((fn) => fn(event))
  return true
}

function setStatus(info: StatusInfo, broadcast: boolean) {
  statusInfo = info
  statusListeners.forEach((fn) => fn())
  if (broadcast) channel?.postMessage({ kind: 'status', info } satisfies ChannelMsg)
}

export function getStatus(): StatusInfo {
  return statusInfo
}

export function onStatus(fn: () => void): () => void {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

export function subscribe(type: string, fn: (e: LumonEvent) => void): () => void {
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  set.add(fn)
  return () => set.delete(fn)
}

/** Parser mínimo de text/event-stream. Llama a onActivity con cada trozo (incluidos heartbeats). */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: LumonEvent) => void,
  onActivity: () => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    onActivity()
    buffer += decoder.decode(value, { stream: true })
    let sep: RegExpExecArray | null
    while ((sep = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const block = buffer.slice(0, sep.index)
      buffer = buffer.slice(sep.index + sep[0].length)
      let id: number | null = null
      let type = 'message'
      const data: string[] = []
      for (const line of block.split(/\r?\n/)) {
        if (line === '' || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'id') id = Number.isFinite(Number(val)) && val !== '' ? Number(val) : null
        else if (field === 'event') type = val
        else if (field === 'data') data.push(val)
      }
      if (data.length === 0) continue
      let parsed: unknown = null
      try {
        parsed = JSON.parse(data.join('\n'))
      } catch {
        parsed = data.join('\n')
      }
      onEvent({ id, type, data: parsed })
    }
  }
}

/** Bucle de la pestaña líder: ticket → stream → reconexión con espera creciente. */
async function runLeader(signal: AbortSignal) {
  let attempt = 0
  while (!signal.aborted) {
    setStatus({ status: attempt === 0 ? 'connecting' : 'reconnecting', leader: true, message: null }, true)
    const conn = new AbortController()
    const abortConn = () => conn.abort()
    signal.addEventListener('abort', abortConn, { once: true })
    let lastActivity = Date.now()
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastActivity > DEAD_AFTER_MS) conn.abort()
    }, 5000)
    let waitMs: number | null = null
    try {
      const { data } = await apiRequest<{ ticket: string }>('/events/tickets', { method: 'POST', signal: conn.signal })
      const qs = new URLSearchParams({ ticket: data.ticket })
      if (lastEventId !== null) qs.set('lastEventId', String(lastEventId))
      const res = await fetch(`${API_BASE_URL}/events/stream?${qs.toString()}`, {
        headers: { Accept: 'text/event-stream' },
        signal: conn.signal,
        cache: 'no-store',
      })
      if (!res.ok || !res.body) throw await toApiError(res)
      attempt = 0
      lastActivity = Date.now()
      setStatus({ status: 'open', leader: true, message: null }, true)
      let superseded = false
      await readStream(
        res.body,
        (event) => {
          if (event.type === 'stream.superseded') {
            superseded = true
            conn.abort()
            return
          }
          if (deliver(event)) channel?.postMessage({ kind: 'event', event } satisfies ChannelMsg)
        },
        () => {
          lastActivity = Date.now()
        },
      )
      // El servidor cerró a propósito (cada pocos minutos): reconectar pronto con lastEventId.
      waitMs = superseded ? 5000 : 1000
    } catch (err) {
      if (signal.aborted) break
      if (err instanceof ApiError) {
        if (err.code === 'SESSION_REVOKED') {
          endSession('SESSION_REVOKED')
          break
        }
        if (err.code === 'CLEARANCE_REQUIRED') {
          setStatus({ status: 'closed', leader: true, message: 'Piso de Pruebas cerrado: sin eventos.' }, true)
          waitMs = 60_000
        }
      }
      // Red, 503, ticket inválido o conexión muerta (watchdog): espera creciente.
    } finally {
      window.clearInterval(watchdog)
      signal.removeEventListener('abort', abortConn)
    }
    if (signal.aborted) break
    const delay = waitMs ?? backoffMs(attempt, null)
    attempt++
    setStatus(
      { status: 'reconnecting', leader: true, message: `Reconectando en ${Math.ceil(delay / 1000)} s…` },
      true,
    )
    try {
      await sleep(delay, signal)
    } catch {
      break
    }
  }
}

/** Arranca el stream en esta pestaña (como líder o seguidora). Devuelve la función para detenerlo. */
export function startEvents(): () => void {
  running++
  if (running > 1) return stopOnce()
  stopController = new AbortController()
  const signal = stopController.signal

  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel('lumon-events')
    channel.onmessage = (e: MessageEvent<ChannelMsg>) => {
      const msg = e.data
      if (msg.kind === 'event') deliver(msg.event)
      else if (msg.kind === 'status' && !statusInfo.leader) setStatus({ ...msg.info, leader: false }, false)
      else if (msg.kind === 'hello' && statusInfo.leader) channel?.postMessage({ kind: 'status', info: statusInfo } satisfies ChannelMsg)
    }
    channel.postMessage({ kind: 'hello' } satisfies ChannelMsg)
  }

  setStatus({ status: 'connecting', leader: false, message: null }, false)
  if ('locks' in navigator) {
    navigator.locks
      .request(LOCK, { signal }, async () => {
        await runLeader(signal)
      })
      .catch(() => undefined)
  } else {
    void runLeader(signal)
  }
  return stopOnce()
}

function stopOnce(): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    running--
    if (running > 0) return
    stopController?.abort()
    stopController = null
    channel?.close()
    channel = null
    setStatus({ status: 'idle', leader: false, message: null }, false)
  }
}
