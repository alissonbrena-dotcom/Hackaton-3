import { apiRequest } from '../api/client'
import { WS_BASE_URL } from '../api/config'
import { backoffMs } from '../api/files'
import type { Cell } from '../api/files'

/**
 * Piso compartido de un archivo (WebSocket nativo, protocolo de /floor/ws).
 *
 * - Ticket nuevo en cada conexión (POST /floor/tickets).
 * - Reconexión según el código de cierre: los definitivos no reconectan.
 * - Latido con ping cada 10 s; dos pong sin llegar → conexión muerta → se cierra y reconecta.
 * - Estado (miembros y reservas) reconstruido desde snapshot; ante un salto de seq, resync.
 * - Los cursores van en un canal aparte para no re-renderizar la grilla.
 */

export interface Member {
  userId: number
  displayName: string
  r: number | null
  c: number | null
}

export interface Claim {
  claimId: string
  userId: number
  displayName: string
  cells: Cell[]
  expiresAt: string
}

export type FloorStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type ClaimResult =
  | { ok: true; claimId: string; cells: Cell[] }
  | { ok: false; reason: 'HELD' | 'NOT_A_GROUP' | 'UNAVAILABLE'; holder: string | null }

const TERMINAL: Record<number, string> = {
  4400: 'Mensaje inválido enviado al piso.',
  4403: 'Sin permiso para el piso compartido (origen o sesión).',
  4404: 'El archivo no existe.',
  4423: 'El Piso de Pruebas está cerrado.',
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function toCells(v: unknown): Cell[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is Cell => isRecord(x) && typeof x.r === 'number' && typeof x.c === 'number')
}

export class FloorClient {
  readonly fileId: number
  myUserId: number | null = null
  status: FloorStatus = 'connecting'
  message: string | null = null
  members = new Map<number, Member>()
  claims = new Map<string, Claim>()
  /** Mi reserva actual (una por conexión). */
  myClaim: { claimId: string; cells: Cell[]; anchor: Cell } | null = null

  private ws: WebSocket | null = null
  private seq: number | null = null
  private attempt = 0
  private ticketFailures = 0
  private disposed = false
  private reconnectTimer: number | null = null
  private pingTimer: number | null = null
  private renewTimer: number | null = null
  private missedPongs = 0
  private lastCursorSent = 0
  private pendingCursor: Cell | null = null
  private cursorTimer: number | null = null
  private requestSeq = 0
  private pendingClaims = new Map<string, { resolve: (r: ClaimResult) => void; timer: number; anchor: Cell }>()
  private stateListeners = new Set<() => void>()
  private cursorListeners = new Set<() => void>()
  private stateVersion = 0
  private cursorVersion = 0

  constructor(fileId: number) {
    this.fileId = fileId
    void this.connect()
  }

  // ---- suscripciones (useSyncExternalStore) ----
  subscribeState = (fn: () => void) => {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }
  getStateVersion = () => this.stateVersion
  subscribeCursors = (fn: () => void) => {
    this.cursorListeners.add(fn)
    return () => this.cursorListeners.delete(fn)
  }
  getCursorVersion = () => this.cursorVersion

  private emitState() {
    this.stateVersion++
    this.stateListeners.forEach((fn) => fn())
  }
  private emitCursors() {
    this.cursorVersion++
    this.cursorListeners.forEach((fn) => fn())
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  // ---- conexión ----
  private async connect() {
    if (this.disposed) return
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting', null)
    let ticket: string
    try {
      const { data } = await apiRequest<{ ticket: string }>('/floor/tickets', { method: 'POST', json: { fileId: this.fileId } })
      ticket = data.ticket
    } catch {
      this.scheduleReconnect(backoffMs(this.attempt, null))
      return
    }
    if (this.disposed) return
    const ws = new WebSocket(`${WS_BASE_URL}/floor/ws?ticket=${encodeURIComponent(ticket)}`)
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.missedPongs = 0
      this.setStatus('open', null)
      this.startPing()
    }
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') this.onMessage(e.data)
    }
    ws.onclose = (e: CloseEvent) => this.onClose(ws, e)
  }

  private onClose(ws: WebSocket, e: CloseEvent) {
    if (this.ws !== ws) return
    this.ws = null
    this.stopTimers()
    this.seq = null
    this.members.clear()
    this.claims.clear()
    // Al cortarse, el servidor libera mis reservas: hay que volver a pedirlas al reconectar.
    const hadClaim = this.myClaim
    this.myClaim = null
    this.failPendingClaims()
    this.emitCursors()
    if (this.disposed) return

    const terminal = TERMINAL[e.code]
    if (terminal) {
      this.setStatus('closed', `${terminal}${e.reason ? ` (${e.reason})` : ''}`)
      return
    }
    if (e.code === 4401) {
      this.ticketFailures++
      if (this.ticketFailures >= 2) {
        this.setStatus('closed', 'El ticket del piso fue rechazado dos veces. Recarga la página para reintentar.')
        return
      }
      this.reconnectAfterClaim(hadClaim, 0)
      return
    }
    this.ticketFailures = 0
    if (e.code === 4429) {
      this.reconnectAfterClaim(hadClaim, 10_000)
      return
    }
    if (e.code === 4408) {
      this.reconnectAfterClaim(hadClaim, 0)
      return
    }
    // 1006, 1011, 1012 y otros: corte o reinicio → espera creciente.
    this.reconnectAfterClaim(hadClaim, backoffMs(this.attempt, null))
  }

  private reconnectAfterClaim(hadClaim: FloorClient['myClaim'], delay: number) {
    this.reclaimAnchor = hadClaim?.anchor ?? null
    this.scheduleReconnect(delay)
  }

  /** Celda de la reserva que había antes del corte: se vuelve a pedir tras el snapshot. */
  private reclaimAnchor: Cell | null = null
  onReclaimResult: ((r: ClaimResult) => void) | null = null

  private scheduleReconnect(delay: number) {
    if (this.disposed) return
    this.attempt++
    this.setStatus('reconnecting', `Reconectando en ${Math.ceil(delay / 1000)} s…`)
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private setStatus(status: FloorStatus, message: string | null) {
    this.status = status
    this.message = message
    this.emitState()
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private startPing() {
    this.pingTimer = window.setInterval(() => {
      if (this.missedPongs >= 2) {
        // Dos pong sin llegar: conexión muerta.
        this.ws?.close(4000, 'dead')
        if (this.ws) this.onClose(this.ws, new CloseEvent('close', { code: 1006 }))
        return
      }
      this.missedPongs++
      this.send({ type: 'ping', t: Date.now() })
    }, 10_000)
  }

  private stopTimers() {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer)
    if (this.renewTimer !== null) window.clearInterval(this.renewTimer)
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer)
    this.pingTimer = null
    this.renewTimer = null
    this.cursorTimer = null
  }

  // ---- mensajes ----
  private onMessage(raw: string) {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(msg) || typeof msg.type !== 'string') return

    if (typeof msg.seq === 'number' && msg.type !== 'snapshot') {
      if (this.seq !== null && msg.seq !== this.seq + 1) {
        // Salto de seq: se perdió algo → resync y reconstruir desde snapshot.
        this.seq = null
        this.send({ type: 'resync' })
        return
      }
      if (this.seq !== null) this.seq = msg.seq
    }

    switch (msg.type) {
      case 'snapshot': {
        this.seq = typeof msg.seq === 'number' ? msg.seq : null
        this.members.clear()
        this.claims.clear()
        if (Array.isArray(msg.members)) {
          for (const m of msg.members) {
            if (isRecord(m) && typeof m.userId === 'number') {
              this.members.set(m.userId, {
                userId: m.userId,
                displayName: typeof m.displayName === 'string' ? m.displayName : `Usuario ${m.userId}`,
                r: typeof m.r === 'number' ? m.r : null,
                c: typeof m.c === 'number' ? m.c : null,
              })
            }
          }
        }
        if (Array.isArray(msg.claims)) for (const c of msg.claims) this.upsertClaim(c)
        if (this.myClaim && !this.claims.has(this.myClaim.claimId)) this.myClaim = null
        this.emitState()
        this.emitCursors()
        if (this.reclaimAnchor) {
          const anchor = this.reclaimAnchor
          this.reclaimAnchor = null
          void this.claim(anchor).then((r) => this.onReclaimResult?.(r))
        }
        break
      }
      case 'member.joined':
        if (typeof msg.userId === 'number' && !this.members.has(msg.userId)) {
          this.members.set(msg.userId, {
            userId: msg.userId,
            displayName: typeof msg.displayName === 'string' ? msg.displayName : `Usuario ${msg.userId}`,
            r: null,
            c: null,
          })
          this.emitState()
          this.emitCursors()
        }
        break
      case 'member.left':
        if (typeof msg.userId === 'number') {
          this.members.delete(msg.userId)
          this.emitState()
          this.emitCursors()
        }
        break
      case 'cursor':
        if (typeof msg.userId === 'number' && typeof msg.r === 'number' && typeof msg.c === 'number') {
          const m = this.members.get(msg.userId)
          if (m) {
            m.r = msg.r
            m.c = msg.c
          } else {
            this.members.set(msg.userId, { userId: msg.userId, displayName: `Usuario ${msg.userId}`, r: msg.r, c: msg.c })
          }
          this.emitCursors()
        }
        break
      case 'claim.granted': {
        this.upsertClaim(msg)
        const pending = typeof msg.requestId === 'string' ? this.pendingClaims.get(msg.requestId) : undefined
        if (pending && typeof msg.claimId === 'string') {
          window.clearTimeout(pending.timer)
          this.pendingClaims.delete(msg.requestId as string)
          const cells = toCells(msg.cells)
          this.myClaim = { claimId: msg.claimId, cells, anchor: pending.anchor }
          this.startRenew()
          pending.resolve({ ok: true, claimId: msg.claimId, cells })
        }
        this.emitState()
        break
      }
      case 'claim.denied': {
        const pending = typeof msg.requestId === 'string' ? this.pendingClaims.get(msg.requestId) : undefined
        if (pending) {
          window.clearTimeout(pending.timer)
          this.pendingClaims.delete(msg.requestId as string)
          const holder = isRecord(msg.holder) && typeof msg.holder.displayName === 'string' ? msg.holder.displayName : null
          pending.resolve({ ok: false, reason: msg.reason === 'HELD' ? 'HELD' : 'NOT_A_GROUP', holder })
        }
        break
      }
      case 'claim.updated':
        this.upsertClaim(msg)
        this.emitState()
        break
      case 'claim.released':
        if (typeof msg.claimId === 'string') {
          this.claims.delete(msg.claimId)
          if (this.myClaim?.claimId === msg.claimId) this.clearMyClaim()
          this.emitState()
        }
        break
      case 'pong':
        this.missedPongs = 0
        break
    }
  }

  private upsertClaim(v: unknown) {
    if (!isRecord(v) || typeof v.claimId !== 'string' || typeof v.userId !== 'number') return
    this.claims.set(v.claimId, {
      claimId: v.claimId,
      userId: v.userId,
      displayName: typeof v.displayName === 'string' ? v.displayName : `Usuario ${v.userId}`,
      cells: toCells(v.cells),
      expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : '',
    })
  }

  // ---- acciones ----

  /** Mueve mi cursor: máximo 10 mensajes por segundo y nada si la pestaña está oculta. */
  sendCursor(cell: Cell) {
    if (document.hidden) return
    this.pendingCursor = cell
    const now = Date.now()
    const wait = 100 - (now - this.lastCursorSent)
    if (wait <= 0) {
      this.flushCursor()
    } else if (this.cursorTimer === null) {
      this.cursorTimer = window.setTimeout(() => {
        this.cursorTimer = null
        this.flushCursor()
      }, wait)
    }
  }

  private flushCursor() {
    if (!this.pendingCursor || document.hidden) return
    this.lastCursorSent = Date.now()
    this.send({ type: 'cursor', r: this.pendingCursor.r, c: this.pendingCursor.c })
    this.pendingCursor = null
  }

  /** Reserva el grupo de esa celda. Si el piso no está disponible, responde UNAVAILABLE (se puede seguir refinando). */
  claim(anchor: Cell): Promise<ClaimResult> {
    if (!this.connected) return Promise.resolve({ ok: false, reason: 'UNAVAILABLE', holder: null })
    const requestId = `c-${++this.requestSeq}`
    return new Promise<ClaimResult>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pendingClaims.delete(requestId)
        resolve({ ok: false, reason: 'UNAVAILABLE', holder: null })
      }, 6000)
      this.pendingClaims.set(requestId, { resolve, timer, anchor })
      this.send({ type: 'claim', requestId, r: anchor.r, c: anchor.c })
    })
  }

  private startRenew() {
    if (this.renewTimer !== null) window.clearInterval(this.renewTimer)
    this.renewTimer = window.setInterval(() => {
      if (this.myClaim) this.send({ type: 'renew', claimId: this.myClaim.claimId })
    }, 5000)
  }

  private clearMyClaim() {
    this.myClaim = null
    if (this.renewTimer !== null) window.clearInterval(this.renewTimer)
    this.renewTimer = null
  }

  /** Libera mi reserva (al cancelar o salir). Al refinar la libera el servidor. */
  release() {
    if (!this.myClaim) return
    this.send({ type: 'release', claimId: this.myClaim.claimId })
    this.claims.delete(this.myClaim.claimId)
    this.clearMyClaim()
    this.emitState()
  }

  /** Olvida mi reserva sin enviar nada (el servidor ya la liberó al refinar). */
  forgetClaim() {
    if (!this.myClaim) return
    this.claims.delete(this.myClaim.claimId)
    this.clearMyClaim()
    this.emitState()
  }

  private failPendingClaims() {
    for (const [, p] of this.pendingClaims) {
      window.clearTimeout(p.timer)
      p.resolve({ ok: false, reason: 'UNAVAILABLE', holder: null })
    }
    this.pendingClaims.clear()
  }

  dispose() {
    this.disposed = true
    this.release()
    this.stopTimers()
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.failPendingClaims()
    const ws = this.ws
    this.ws = null
    ws?.close(1000, 'bye')
    this.stateListeners.clear()
    this.cursorListeners.clear()
  }
}
