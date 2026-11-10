// Flujo de subida (README, CP4):
//   1. POST /media/tickets            → Lumon da permiso y dice la ruta exacta (dura 10 min)
//   2. subida a Cloudinary            → directo desde el navegador, con progreso real (XHR)
//   3. POST /media/tickets/{id}/confirm → Lumon descarga la imagen, la comprueba y devuelve mediaId
//
// UploadJob recuerda en qué paso quedó: "Reintentar" continúa desde el paso que falló
// (no pide otro ticket si ya lo tiene, no vuelve a subir si la subida ya terminó).

import { apiFetch } from '../api/client'
import { CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET } from '../api/config'
import { ApiError } from '../api/errors'
import { backoffMs, isAbort, sleep } from '../api/files'
import type { PreparedImage, Purpose } from './image'

interface MediaTicket {
  ticketId: string
  expiresAt: string
  provider: 'SUPABASE' | 'CLOUDINARY'
  uploadPublicId?: string
  expectedPublicId?: string
}

export interface ConfirmedMedia {
  mediaId: number
  url: string
  width: number
  height: number
  purpose: Purpose
}

export type UploadPhase = 'idle' | 'ticket' | 'uploading' | 'confirming' | 'done' | 'error' | 'cancelled'

export interface UploadState {
  phase: UploadPhase
  /** 0..1, progreso real de los bytes enviados a Cloudinary. */
  progress: number
  error: string | null
  media: ConfirmedMedia | null
}

const abortError = () => new DOMException('Aborted', 'AbortError')

/** Reintenta 503 y cortes de red con espera creciente (con caos, Lumon responde 503 a veces). */
async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, maxAttempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw abortError()
      const retryable = (err instanceof ApiError && err.status === 503) || err instanceof TypeError
      if (!retryable || attempt + 1 >= maxAttempts) throw err
      await sleep(backoffMs(attempt, err instanceof ApiError ? err.retryAfter : null), signal)
    }
  }
}

/** Sube con XMLHttpRequest porque fetch no informa el progreso de subida. */
function uploadToCloudinary(
  blob: Blob,
  publicId: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<{ secure_url: string; public_id: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const form = new FormData()
    form.append('file', blob, `${publicId.split('/').pop() ?? 'image'}.webp`)
    form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET)
    form.append('public_id', publicId)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // respuesta no JSON
      }
      const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
      if (xhr.status >= 200 && xhr.status < 300 && typeof rec.secure_url === 'string' && typeof rec.public_id === 'string') {
        resolve({ secure_url: rec.secure_url, public_id: rec.public_id })
        return
      }
      const cloudErr = typeof rec.error === 'object' && rec.error !== null ? (rec.error as Record<string, unknown>) : {}
      const msg = typeof cloudErr.message === 'string' ? cloudErr.message : `HTTP ${xhr.status}`
      reject(new Error(`El storage rechazó la imagen: ${msg}`))
    }
    xhr.onerror = () => reject(new TypeError('Sin conexión con el storage.'))
    const onAbort = () => xhr.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    xhr.onabort = () => reject(abortError())
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort)
    xhr.send(form)
  })
}

const VERIFY_REASON: Record<string, string> = {
  HOST_MISMATCH: 'la imagen no está en el storage registrado',
  PATH_MISMATCH: 'la ruta no coincide con la del ticket',
  NOT_FOUND: 'Lumon no encontró la imagen en el storage',
  NOT_WEBP: 'el archivo no es WebP',
  DIMENSIONS: 'las dimensiones no coinciden',
  SIZE: 'el peso no coincide',
  SHA256: 'el archivo cambió (SHA-256 distinto)',
  METADATA_PRESENT: 'la imagen todavía tiene metadatos',
}

export function uploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const d = typeof err.details === 'object' && err.details !== null ? (err.details as Record<string, unknown>) : {}
    switch (err.code) {
      case 'STORAGE_NOT_VERIFIED':
        return 'El storage del equipo todavía no está verificado.'
      case 'TICKET_EXPIRED':
        return 'El permiso de subida venció. Reintenta para pedir uno nuevo.'
      case 'MEDIA_CONSTRAINTS':
        return 'La imagen no cumple el formato, tamaño o peso exigidos.'
      case 'MEDIA_VERIFICATION_FAILED': {
        const reason = typeof d.reason === 'string' ? d.reason : ''
        return `Lumon rechazó la imagen: ${VERIFY_REASON[reason] ?? err.message}.`
      }
      case 'CLEARANCE_REQUIRED':
        return 'El Piso de Pruebas todavía no está abierto.'
      default:
        return err.message
    }
  }
  if (err instanceof Error) return err.message
  return 'No se pudo subir la imagen.'
}

export class UploadJob {
  private ticket: MediaTicket | null = null
  private uploadedUrl: string | null = null
  private controller: AbortController | null = null
  private listeners = new Set<() => void>()
  state: UploadState = { phase: 'idle', progress: 0, error: null, media: null }

  readonly image: PreparedImage
  readonly purpose: Purpose

  constructor(image: PreparedImage, purpose: Purpose) {
    this.image = image
    this.purpose = purpose
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getState = () => this.state

  private set(patch: Partial<UploadState>) {
    this.state = { ...this.state, ...patch } // objeto nuevo: React detecta el cambio
    this.listeners.forEach((fn) => fn())
  }

  cancel() {
    this.controller?.abort()
  }

  /** Empieza o reintenta. Continúa desde el último paso que no terminó. */
  async run(): Promise<ConfirmedMedia | null> {
    if (this.state.phase === 'done') return this.state.media
    if (this.controller !== null) return null // ya está corriendo
    const controller = new AbortController()
    this.controller = controller
    const { signal } = controller
    try {
      // Un ticket vencido no sirve: se pide otro (y hay que volver a subir a la ruta nueva).
      if (this.ticket && Date.parse(this.ticket.expiresAt) - Date.now() < 15_000) {
        this.ticket = null
        this.uploadedUrl = null
      }

      if (this.ticket === null) {
        this.set({ phase: 'ticket', progress: 0, error: null })
        const { image, purpose } = this
        this.ticket = await withRetry(
          () =>
            apiFetch<MediaTicket>('/media/tickets', {
              method: 'POST',
              signal,
              json: { purpose, contentType: 'image/webp', bytes: image.bytes, sha256: image.sha256, width: image.width, height: image.height },
            }),
          signal,
        )
        if (this.ticket.provider !== 'CLOUDINARY' || !this.ticket.uploadPublicId) {
          throw new Error('El storage registrado no es Cloudinary.')
        }
      }

      if (this.uploadedUrl === null) {
        this.set({ phase: 'uploading', progress: 0, error: null })
        const ticket = this.ticket
        const res = await uploadToCloudinary(this.image.blob, ticket.uploadPublicId ?? '', signal, (p) => this.set({ progress: p }))
        if (ticket.expectedPublicId && res.public_id !== ticket.expectedPublicId) {
          throw new Error('El preset de Cloudinary no guardó la imagen en la carpeta del equipo.')
        }
        this.uploadedUrl = res.secure_url
      }

      this.set({ phase: 'confirming', progress: 1, error: null })
      const ticketId = this.ticket.ticketId
      const url = this.uploadedUrl
      // confirm es idempotente: repetirlo devuelve el mismo mediaId.
      const media = await withRetry(
        () => apiFetch<ConfirmedMedia>(`/media/tickets/${ticketId}/confirm`, { method: 'POST', signal, json: { url } }),
        signal,
      )
      this.set({ phase: 'done', media, error: null })
      return media
    } catch (err) {
      if (isAbort(err) || signal.aborted) {
        this.set({ phase: 'cancelled', error: null })
      } else {
        if (err instanceof ApiError && err.code === 'TICKET_EXPIRED') {
          this.ticket = null
          this.uploadedUrl = null
        }
        this.set({ phase: 'error', error: uploadErrorMessage(err) })
      }
      return null
    } finally {
      this.controller = null
    }
  }
}
