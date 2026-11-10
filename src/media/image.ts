// Preparación de imágenes en el navegador: recorte, tamaño, WebP SIN metadatos y SHA-256.
//
// ¿Por qué no quedan metadatos? Porque nunca subimos el archivo original: lo dibujamos en un <canvas>
// y pedimos al canvas un archivo NUEVO. Un canvas solo tiene píxeles, así que el WebP que genera no
// trae EXIF, XMP ni ubicación.

export type Purpose = 'BADGE' | 'INCIDENT'

export const LIMITS = {
  BADGE: { side: 512, maxBytes: 122_880 }, // exactamente 512 × 512, 120 KB
  INCIDENT: { minLong: 800, maxLong: 1600, maxBytes: 307_200 }, // lado mayor 800–1600, 300 KB
} as const

export interface PreparedImage {
  blob: Blob
  width: number
  height: number
  bytes: number
  sha256: string
}

/** Recorte cuadrado en coordenadas de la imagen original. */
export interface SquareCrop {
  x: number
  y: number
  size: number
}

/** Error con un mensaje listo para mostrar al usuario. */
export class ImageError extends Error {}

/** Lee el archivo como imagen. `from-image` aplica la rotación EXIF antes de que perdamos el EXIF. */
export async function loadImage(file: Blob): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new ImageError('El archivo no es una imagen.')
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new ImageError('No se pudo leer la imagen. Prueba con otro archivo.')
  }
}

function canvasOf(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageError('Tu navegador no permite procesar imágenes.')
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

/**
 * Codifica a WebP bajando la calidad hasta que entre en maxBytes.
 * Si el navegador no sabe generar WebP, toBlob devuelve PNG (o null): lo detectamos por el tipo.
 */
async function encodeWebp(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.26]) {
    const blob = await toBlob(canvas, quality)
    if (blob === null || blob.type !== 'image/webp') {
      throw new ImageError('Este navegador no puede generar imágenes WebP. Usa Chrome, Edge o Firefox.')
    }
    if (blob.size <= maxBytes) return blob
  }
  throw new ImageError('No se pudo comprimir la imagen al peso máximo. Prueba con una imagen más simple.')
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function finish(canvas: HTMLCanvasElement, maxBytes: number): Promise<PreparedImage> {
  const blob = await encodeWebp(canvas, maxBytes)
  return { blob, width: canvas.width, height: canvas.height, bytes: blob.size, sha256: await sha256Hex(blob) }
}

/** Fotocheck: recorta el cuadrado elegido y lo lleva a exactamente 512 × 512. */
export function prepareBadge(img: ImageBitmap, crop: SquareCrop): Promise<PreparedImage> {
  const { side, maxBytes } = LIMITS.BADGE
  const ctx = canvasOf(side, side)
  ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, side, side)
  return finish(ctx.canvas, maxBytes)
}

/** Incidencia: escala para que el lado mayor quede entre 800 y 1600 (agranda o achica si hace falta). */
export function prepareIncident(img: ImageBitmap): Promise<PreparedImage> {
  const { minLong, maxLong, maxBytes } = LIMITS.INCIDENT
  const long = Math.max(img.width, img.height)
  const target = Math.min(maxLong, Math.max(minLong, long))
  const scale = target / long
  // El lado mayor queda EXACTO en `target`; el otro se redondea (mínimo 1 px).
  const width = img.width >= img.height ? target : Math.max(1, Math.round(img.width * scale))
  const height = img.width >= img.height ? Math.max(1, Math.round(img.height * scale)) : target
  const ctx = canvasOf(width, height)
  ctx.drawImage(img, 0, 0, width, height)
  return finish(ctx.canvas, maxBytes)
}
