import { apiRequest } from './client'
import { ApiError } from './errors'

// Tipos según Swagger (/openapi.json).

export type Bin = 'WO' | 'FC' | 'DR' | 'MA'
export const BINS: readonly Bin[] = ['WO', 'FC', 'DR', 'MA']
export const BIN_CHAR: Record<Bin, string> = { WO: 'W', FC: 'F', DR: 'D', MA: 'M' }

export type FileStatus = 'ACTIVE' | 'COMPLETE'

export interface Progress {
  WO: number
  FC: number
  DR: number
  MA: number
  overall: number
}

export interface DataFile {
  id: number
  name: string
  rows: number
  cols: number
  tileSize: number
  status: FileStatus
  progress: Progress
  refinedGroups: number
  totalGroups: number
  mistakes: number
  updatedAt: string
}

export interface FilePage {
  content: DataFile[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export interface Rules {
  tremorThreshold: number
  connectivity: 4 | 8
  minGroupSize: number
  maxGroupSize: number
  binning: { strategy: 'DIGIT_SUM_MOD' | 'MAX_DIGIT_MOD'; order: Bin[] }
}

export interface TileDto {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: string
  tremor: string
  bins: string
  version: number
}

export interface Cell {
  r: number
  c: number
}

export interface RefineResult {
  refinementId: number
  bin: Bin
  size: number
  file: Pick<DataFile, 'progress' | 'refinedGroups' | 'totalGroups' | 'mistakes' | 'status'>
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = window.setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** Espera creciente con jitter: 0.5s, 1s, 2s, 4s… (máx. 8s), o Retry-After si es mayor. */
export function backoffMs(attempt: number, retryAfterSec: number | null): number {
  const exp = Math.min(8000, 500 * 2 ** attempt)
  const jitter = Math.random() * 250
  return Math.max(exp + jitter, (retryAfterSec ?? 0) * 1000)
}

/** GET con reintentos ante 503 (y fallos de red), con espera creciente. */
export async function getWithRetry<T>(path: string, signal?: AbortSignal, maxAttempts = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await apiRequest<T>(path, { signal })).data
    } catch (err) {
      if (isAbort(err)) throw err
      const retryable = (err instanceof ApiError && err.status === 503) || err instanceof TypeError
      if (!retryable || attempt + 1 >= maxAttempts) throw err
      await sleep(backoffMs(attempt, err instanceof ApiError ? err.retryAfter : null), signal)
    }
  }
}

export const getFile = (id: number, signal?: AbortSignal) => getWithRetry<DataFile>(`/files/${id}`, signal)
export const getRules = (id: number, signal?: AbortSignal) => getWithRetry<Rules>(`/files/${id}/rules`, signal)
