import { apiRequest } from '../../api/client'
import { ApiError } from '../../api/errors'
import { backoffMs, isAbort, type TileDto } from '../../api/files'

/** Bloque decodificado. Los arreglos están en orden por filas (rows × cols). */
export interface Tile {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: Uint8Array // dígitos 0..9
  tremor: Uint8Array // 0..100
  bins: string[] // '.', 'W', 'F', 'D', 'M'
  version: number
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeTile(dto: TileDto): Tile {
  const values = new Uint8Array(dto.values.length)
  for (let i = 0; i < dto.values.length; i++) values[i] = dto.values.charCodeAt(i) - 48
  return {
    tileRow: dto.tileRow,
    tileCol: dto.tileCol,
    originRow: dto.originRow,
    originCol: dto.originCol,
    rows: dto.rows,
    cols: dto.cols,
    values,
    tremor: decodeBase64(dto.tremor),
    bins: dto.bins.split(''),
    version: dto.version,
  }
}

export const tileKey = (tr: number, tc: number) => `${tr}:${tc}`

interface Entry {
  tr: number
  tc: number
  /** Promesas que necesitan este bloque (p. ej. la búsqueda de un grupo). Si hay alguna, no se cancela. */
  waiters: { resolve: (t: Tile) => void; reject: (e: unknown) => void }[]
  visible: boolean
  attempt: number
  controller: AbortController | null // != null mientras está en vuelo
  notBefore: number // reintento con espera (503)
}

/** Límite del servidor: 40 bloques cada 10 s por sesión. Nos quedamos un poco por debajo. */
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 36
const MAX_CONCURRENT = 6

export class TileStore {
  readonly fileId: number
  readonly tileSize: number
  readonly tileRows: number
  readonly tileCols: number
  private tiles = new Map<string, Tile>()
  private entries = new Map<string, Entry>() // pendientes o en vuelo
  private sent: number[] = [] // timestamps de requests enviadas (ventana deslizante)
  private pausedUntil = 0 // 429: no se pide nada hasta acá
  private timer: number | null = null
  private listeners = new Set<() => void>()
  private disposed = false
  private lastVisible: { tr: number; tc: number }[] = []
  /** Cambia con cada modificación: sirve para useSyncExternalStore. */
  version = 0
  /** Mensaje de estado para la UI (p. ej. esperando Retry-After). */
  status: string | null = null

  constructor(fileId: number, rows: number, cols: number, tileSize: number) {
    this.fileId = fileId
    this.tileSize = tileSize
    this.tileRows = Math.ceil(rows / tileSize)
    this.tileCols = Math.ceil(cols / tileSize)
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = () => this.version

  private emit() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  getTile(tr: number, tc: number): Tile | undefined {
    return this.tiles.get(tileKey(tr, tc))
  }

  /** Celda global → bloque + índice local. undefined si el bloque no está cargado. */
  cellAt(r: number, c: number): { tile: Tile; i: number } | undefined {
    const tile = this.tiles.get(tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
    if (!tile) return undefined
    return { tile, i: (r - tile.originRow) * tile.cols + (c - tile.originCol) }
  }

  /**
   * Bloques que la vista necesita ahora. Los que salieron de la vista y nadie más espera
   * se cancelan (si estaban en vuelo) o se sacan de la cola.
   */
  setVisible(keys: { tr: number; tc: number }[]) {
    this.lastVisible = keys
    const wanted = new Set(keys.map((k) => tileKey(k.tr, k.tc)))
    for (const [key, e] of this.entries) {
      e.visible = wanted.has(key)
      if (!e.visible && e.waiters.length === 0) {
        e.controller?.abort()
        this.entries.delete(key)
      }
    }
    for (const { tr, tc } of keys) {
      const key = tileKey(tr, tc)
      if (this.tiles.has(key) || this.entries.has(key)) continue
      this.entries.set(key, { tr, tc, waiters: [], visible: true, attempt: 0, controller: null, notBefore: 0 })
    }
    this.pump()
  }

  /** Pide un bloque (o devuelve el de caché). Comparte la request si ya está en vuelo. */
  ensure(tr: number, tc: number): Promise<Tile> {
    const key = tileKey(tr, tc)
    const cached = this.tiles.get(key)
    if (cached) return Promise.resolve(cached)
    return new Promise<Tile>((resolve, reject) => {
      let e = this.entries.get(key)
      if (!e) {
        e = { tr, tc, waiters: [], visible: false, attempt: 0, controller: null, notBefore: 0 }
        this.entries.set(key, e)
      }
      e.waiters.push({ resolve, reject })
      this.pump()
    })
  }

  /** Invalida bloques (p. ej. tras 409 ALREADY_REFINED) y los vuelve a pedir. */
  invalidate(tiles: [number, number][]) {
    for (const [tr, tc] of tiles) this.tiles.delete(tileKey(tr, tc))
    this.emit()
    for (const [tr, tc] of tiles) void this.ensure(tr, tc).catch(() => undefined)
  }

  /** stream.reset: se descarta la caché y se vuelven a pedir los bloques visibles. */
  invalidateAll() {
    this.tiles.clear()
    this.emit()
    this.setVisible(this.lastVisible)
  }

  /** Marca celdas como refinadas sin volver a pedir la grilla. */
  markRefined(cells: { r: number; c: number }[], binChar: string) {
    for (const { r, c } of cells) {
      const hit = this.cellAt(r, c)
      if (hit) hit.tile.bins[hit.i] = binChar
    }
    this.emit()
  }

  dispose() {
    this.disposed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    for (const e of this.entries.values()) {
      e.controller?.abort()
      e.waiters.forEach((w) => w.reject(new DOMException('Aborted', 'AbortError')))
    }
    this.entries.clear()
    this.listeners.clear()
  }

  private schedule(ms: number) {
    if (this.disposed) return
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.pump()
    }, Math.max(0, ms))
  }

  private setStatus(s: string | null) {
    if (s !== this.status) {
      this.status = s
      this.emit()
    }
  }

  private pump() {
    if (this.disposed) return
    const now = Date.now()
    if (now < this.pausedUntil) {
      this.schedule(this.pausedUntil - now)
      return
    }
    this.setStatus(null)
    this.sent = this.sent.filter((t) => now - t < WINDOW_MS)
    let inFlight = 0
    for (const e of this.entries.values()) if (e.controller) inFlight++

    // Primero lo que alguien espera (grupo), después lo visible.
    const pending = [...this.entries.values()]
      .filter((e) => !e.controller)
      .sort((a, b) => b.waiters.length - a.waiters.length)

    let nextWake = Infinity
    for (const e of pending) {
      if (inFlight >= MAX_CONCURRENT) break
      if (e.notBefore > now) {
        nextWake = Math.min(nextWake, e.notBefore - now)
        continue
      }
      if (this.sent.length >= MAX_PER_WINDOW) {
        nextWake = Math.min(nextWake, WINDOW_MS - (now - this.sent[0]) + 10)
        break
      }
      this.sent.push(now)
      inFlight++
      void this.fetchTile(e)
    }
    if (nextWake !== Infinity) this.schedule(nextWake)
  }

  private async fetchTile(e: Entry) {
    const key = tileKey(e.tr, e.tc)
    const controller = new AbortController()
    e.controller = controller
    try {
      const { data } = await apiRequest<TileDto>(`/files/${this.fileId}/tiles/${e.tr}/${e.tc}`, {
        signal: controller.signal,
      })
      if (this.disposed) return
      const tile = decodeTile(data)
      this.tiles.set(key, tile)
      if (this.entries.get(key) === e) this.entries.delete(key)
      e.waiters.forEach((w) => w.resolve(tile))
      this.emit()
    } catch (err) {
      e.controller = null
      if (this.disposed || isAbort(err)) return
      if (err instanceof ApiError && err.status === 429) {
        // Nadie pide nada hasta que pase Retry-After.
        this.pausedUntil = Date.now() + (err.retryAfter ?? 1) * 1000
        this.setStatus(`Demasiadas solicitudes: esperando ${err.retryAfter ?? 1} s…`)
      } else if ((err instanceof ApiError && err.status === 503) || err instanceof TypeError) {
        e.notBefore = Date.now() + backoffMs(e.attempt, err instanceof ApiError ? err.retryAfter : null)
        e.attempt++
        if (e.attempt > 6) {
          this.entries.delete(key)
          e.waiters.forEach((w) => w.reject(err))
        }
      } else {
        this.entries.delete(key)
        e.waiters.forEach((w) => w.reject(err))
      }
    } finally {
      this.pump()
    }
  }
}
