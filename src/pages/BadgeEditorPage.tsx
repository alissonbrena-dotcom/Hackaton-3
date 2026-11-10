import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/errors'
import { isAbort } from '../api/files'
import { getRefiner, patchRefiner, type Refiner } from '../api/refiners'
import { useAuth } from '../auth/context'
import { ImageError, loadImage, prepareBadge, type SquareCrop } from '../media/image'
import { UploadStatus, useMaybeUploadState } from '../media/UploadStatus'
import { UploadJob } from '../media/upload'

const VIEW = 288 // px del visor cuadrado

interface Source {
  bitmap: ImageBitmap
  url: string // object URL para mostrarla en el visor
}

/** Recorte = cuadrado en coordenadas de la imagen: centro (cx, cy) y lado (size). */
interface Crop {
  cx: number
  cy: number
  size: number
}

function clampCrop(c: Crop, w: number, h: number): Crop {
  const size = Math.min(Math.max(c.size, Math.min(w, h) / 8), Math.min(w, h))
  const half = size / 2
  return {
    size,
    cx: Math.min(Math.max(c.cx, half), w - half),
    cy: Math.min(Math.max(c.cy, half), h - half),
  }
}

const toSquare = (c: Crop): SquareCrop => ({ x: c.cx - c.size / 2, y: c.cy - c.size / 2, size: c.size })

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; refiner: Refiner; etag: string }

export default function BadgeEditorPage() {
  const { id: idParam } = useParams()
  const id = Number(idParam)
  const { can } = useAuth()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [source, setSource] = useState<Source | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [job, setJob] = useState<UploadJob | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<{ refiner: Refiner; etag: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null)
  const jobState = useMaybeUploadState(job)

  useEffect(() => {
    if (!Number.isInteger(id) || id < 1) {
      setLoad({ status: 'error', message: 'Ese expediente no existe.' })
      return
    }
    const controller = new AbortController()
    getRefiner(id, controller.signal)
      .then(({ refiner, etag }) => setLoad({ status: 'ok', refiner, etag }))
      .catch((err: unknown) => {
        if (isAbort(err)) return
        setLoad({ status: 'error', message: err instanceof ApiError ? err.message : 'No se pudo conectar con Lumon.' })
      })
    return () => controller.abort()
  }, [id])

  // Libera la imagen anterior al cambiarla o al salir.
  useEffect(() => {
    if (!source) return
    return () => {
      URL.revokeObjectURL(source.url)
      source.bitmap.close()
    }
  }, [source])

  // Al salir de la página, cancela la subida en curso.
  useEffect(() => () => job?.cancel(), [job])

  const pickFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return
    setError(null)
    setJob(null)
    setSaved(false)
    try {
      const bitmap = await loadImage(file)
      const side = Math.min(bitmap.width, bitmap.height)
      setSource({ bitmap, url: URL.createObjectURL(file) })
      setCrop({ cx: bitmap.width / 2, cy: bitmap.height / 2, size: side })
    } catch (err) {
      setError(err instanceof ImageError ? err.message : 'No se pudo leer la imagen.')
    }
  }, [])

  // ---- Recorte: arrastre (Pointer Events), rueda/slider (zoom) y teclado ----
  const w = source?.bitmap.width ?? 1
  const h = source?.bitmap.height ?? 1
  const scale = crop ? VIEW / crop.size : 1 // px de pantalla por px de imagen
  const update = (c: Crop) => setCrop(clampCrop(c, w, h))

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!crop) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, crop }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // Mover el dedo a la derecha mueve la imagen a la derecha → el recorte va a la izquierda.
    update({ ...d.crop, cx: d.crop.cx - (e.clientX - d.x) / scale, cy: d.crop.cy - (e.clientY - d.y) / scale })
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const zoomBy = (factor: number) => crop && update({ ...crop, size: crop.size / factor })
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!crop) return
    const step = crop.size / 20
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (e.key in moves) {
      const [dx, dy] = moves[e.key]
      update({ ...crop, cx: crop.cx + dx, cy: crop.cy + dy })
    } else if (e.key === '+' || e.key === '=') zoomBy(1.1)
    else if (e.key === '-') zoomBy(1 / 1.1)
    else return
    e.preventDefault()
  }

  const minSide = Math.min(w, h)
  const zoom = crop ? minSide / crop.size : 1

  // ---- Generar + subir ----
  const prepareAndUpload = async () => {
    if (!source || !crop) return
    setError(null)
    setPreparing(true)
    try {
      const image = await prepareBadge(source.bitmap, toSquare(crop))
      const next = new UploadJob(image, 'BADGE')
      setJob(next)
      const media = await next.run()
      if (media) await saveBadge(media.mediaId)
    } catch (err) {
      setError(err instanceof ImageError ? err.message : 'No se pudo preparar la imagen.')
    } finally {
      setPreparing(false)
    }
  }

  // ---- Guardar en el expediente con If-Match (Regla de Milchick) ----
  const saveBadge = async (mediaId: number, etagOverride?: string) => {
    if (load.status !== 'ok') return
    setSaving(true)
    setError(null)
    try {
      const res = await patchRefiner(id, etagOverride ?? load.etag, { badgeMediaId: mediaId })
      setLoad({ status: 'ok', refiner: res.refiner, etag: res.etag })
      setConflict(null)
      setSaved(true)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        // Alguien cambió el expediente: mostramos la versión actual y el usuario decide.
        const current = typeof err.details === 'object' && err.details !== null ? (err.details as { current?: Refiner }).current : undefined
        if (current) setConflict({ refiner: current, etag: `"${current.version}"` })
        else setError('El expediente cambió mientras editabas. Recarga la página.')
      } else if (err instanceof ApiError && err.code === 'MEDIA_NOT_USABLE') {
        setError('Esa imagen ya no se puede usar. Sube otra.')
      } else {
        setError(err instanceof ApiError ? err.message : 'No se pudo guardar. Reintenta.')
      }
    } finally {
      setSaving(false)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    void pickFile(e.dataTransfer.files[0])
  }
  const onPaste = (e: ReactClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      void pickFile(file)
    }
  }

  if (!can('media:upload')) return <p role="alert">Tu rol no puede subir imágenes.</p>
  if (load.status === 'loading') return <p role="status">Cargando expediente…</p>
  if (load.status === 'error') {
    return (
      <div role="alert" className="space-y-2">
        <p>{load.message}</p>
        <Link to="/refiners" className="text-sky-300 underline">
          Volver al personal
        </Link>
      </div>
    )
  }

  const { refiner } = load
  const media = jobState?.media ?? null
  const uploading = jobState !== null && (jobState.phase === 'ticket' || jobState.phase === 'uploading' || jobState.phase === 'confirming')
  const busy = preparing || saving

  return (
    <section aria-labelledby="badge-title" className="space-y-4" onPaste={onPaste}>
      <div className="flex items-baseline gap-3">
        <h1 id="badge-title" className="text-2xl font-bold">
          Fotocheck de {refiner.fullName}
        </h1>
        <Link to="/refiners" className="ml-auto text-sm text-sky-300 underline">
          Volver al personal
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-[auto_1fr]">
        <div className="space-y-2">
          <p className="text-sm text-slate-400">Actual</p>
          {refiner.badge ? (
            <img src={refiner.badge.url} width={160} height={160} alt={`Fotocheck actual de ${refiner.fullName}`} className="h-40 w-40 rounded-md bg-slate-800 object-cover" />
          ) : (
            <div className="grid h-40 w-40 place-items-center rounded-md bg-slate-800 text-sm text-slate-400">Sin foto</div>
          )}
          {saved && (
            <p role="status" className="text-sm text-emerald-300">
              Fotocheck actualizado.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="rounded-md border-2 border-dashed border-slate-600 p-4 text-sm"
          >
            <label className="block">
              Elige una imagen, arrástrala aquí o pégala (Ctrl/Cmd + V).
              <input type="file" accept="image/*" onChange={(e) => void pickFile(e.target.files?.[0])} className="mt-2 block text-sm" />
            </label>
          </div>

          {source && crop && (
            <div className="space-y-2">
              <div
                role="application"
                aria-label="Recorte del fotocheck. Flechas para mover, + y - para acercar o alejar."
                tabIndex={0}
                onKeyDown={onKeyDown}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08)}
                style={{ width: VIEW, height: VIEW }}
                className="relative cursor-move touch-none overflow-hidden rounded-md bg-slate-900 outline-none ring-sky-400 focus:ring-2"
              >
                <img
                  src={source.url}
                  alt=""
                  draggable={false}
                  style={{
                    position: 'absolute',
                    maxWidth: 'none',
                    width: w * scale,
                    height: h * scale,
                    left: -(crop.cx - crop.size / 2) * scale,
                    top: -(crop.cy - crop.size / 2) * scale,
                  }}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                Zoom
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={0.05}
                  value={zoom}
                  onChange={(e) => update({ ...crop, size: minSide / Number(e.target.value) })}
                />
              </label>
              <button
                type="button"
                disabled={busy || uploading}
                onClick={() => void prepareAndUpload()}
                className="rounded-md bg-sky-700 px-4 py-2 font-semibold hover:bg-sky-600 disabled:opacity-60"
              >
                {preparing ? 'Preparando…' : 'Usar este recorte'}
              </button>
            </div>
          )}

          {job && <UploadStatus job={job} label="el fotocheck" />}

          {media && !saved && !conflict && (
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveBadge(media.mediaId)}
              className="rounded-md border border-slate-600 px-3 py-1 text-sm hover:bg-slate-800"
            >
              {saving ? 'Guardando…' : 'Guardar en el expediente'}
            </button>
          )}

          {conflict && media && (
            <div role="alert" className="space-y-2 rounded-md border border-amber-600 bg-amber-950/40 p-3 text-sm">
              <p>
                Alguien cambió este expediente mientras trabajabas (ahora va en la versión {conflict.refiner.version}). El fotocheck
                es lo único que se va a cambiar.
              </p>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveBadge(media.mediaId, conflict.etag)}
                className="rounded-md bg-amber-700 px-3 py-1 hover:bg-amber-600"
              >
                Aplicar el fotocheck sobre la versión actual
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
