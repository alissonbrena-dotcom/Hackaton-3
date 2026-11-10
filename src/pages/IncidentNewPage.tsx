import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, fieldErrors } from '../api/errors'
import { createIncident, SEVERITIES, SEVERITY_LABEL, type Severity } from '../api/incidents'
import { ImageError, loadImage, prepareIncident } from '../media/image'
import { UploadStatus, useUploadState } from '../media/UploadStatus'
import { UploadJob } from '../media/upload'

const MAX_PHOTOS = 3

interface Photo {
  key: number
  name: string
  job: UploadJob | null // null mientras se prepara (recorte/WebP/SHA-256)
  error: string | null
}

/** Una fila por foto: su progreso, cancelar, reintentar y quitar. */
function PhotoRow({ photo, onRemove, onState }: { photo: Photo; onRemove: () => void; onState: (done: number | null) => void }) {
  return (
    <li className="space-y-1 rounded-md border border-slate-800 p-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate">{photo.name}</span>
        <button type="button" onClick={onRemove} className="text-rose-300 underline">
          Quitar<span className="sr-only"> {photo.name}</span>
        </button>
      </div>
      {photo.error && (
        <p role="alert" className="text-sm text-rose-300">
          {photo.error}
        </p>
      )}
      {!photo.error && !photo.job && <p className="text-sm">Preparando la imagen…</p>}
      {photo.job && <JobWatcher job={photo.job} onState={onState} name={photo.name} />}
    </li>
  )
}

function JobWatcher({ job, onState, name }: { job: UploadJob; onState: (mediaId: number | null) => void; name: string }) {
  const state = useUploadState(job)
  const mediaId = state.media?.mediaId ?? null
  useEffect(() => onState(mediaId), [mediaId, onState])
  return <UploadStatus job={job} label={name} />
}

export default function IncidentNewPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('MEDIUM')
  const [fileId, setFileId] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [confirmed, setConfirmed] = useState<Record<number, number>>({}) // key de la foto → mediaId
  const [sending, setSending] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const nextKey = useRef(1)
  const photosRef = useRef(photos)
  photosRef.current = photos

  // Al salir de la página, cancela las subidas en curso.
  useEffect(() => () => photosRef.current.forEach((p) => p.job?.cancel()), [])

  const addFiles = (files: FileList | null) => {
    if (!files) return
    const room = MAX_PHOTOS - photos.length
    const chosen = [...files].slice(0, Math.max(0, room))
    for (const file of chosen) {
      const key = nextKey.current++
      setPhotos((prev) => [...prev, { key, name: file.name, job: null, error: null }])
      // Cada foto se prepara y se sube por su cuenta: van EN PARALELO.
      void (async () => {
        try {
          const bitmap = await loadImage(file)
          const image = await prepareIncident(bitmap)
          bitmap.close()
          const job = new UploadJob(image, 'INCIDENT')
          setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, job } : p)))
          await job.run()
        } catch (err) {
          const msg = err instanceof ImageError ? err.message : 'No se pudo preparar la imagen.'
          setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, error: msg } : p)))
        }
      })()
    }
  }

  const removePhoto = (key: number) => {
    setPhotos((prev) => {
      prev.find((p) => p.key === key)?.job?.cancel()
      return prev.filter((p) => p.key !== key)
    })
    setConfirmed((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const allConfirmed = photos.length >= 1 && photos.every((p) => confirmed[p.key] !== undefined)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!allConfirmed || sending) return
    setSending(true)
    setErrors({})
    setFormError(null)
    try {
      const fid = Number(fileId)
      await createIncident({
        title: title.trim(),
        description: description.trim(),
        severity,
        fileId: fileId.trim() !== '' && Number.isInteger(fid) && fid > 0 ? fid : null,
        mediaIds: photos.map((p) => confirmed[p.key]),
      })
      navigate('/incidents')
    } catch (err) {
      // El formulario y las fotos confirmadas se conservan: se puede reintentar tal cual.
      if (err instanceof ApiError) {
        setErrors(fieldErrors(err))
        if (err.code === 'MEDIA_NOT_USABLE') setFormError('Alguna foto ya no se puede usar. Quítala y súbela de nuevo.')
        else if (err.status === 503) setFormError('Lumon no respondió y el reporte NO se guardó. Vuelve a enviarlo.')
        else setFormError(err.message)
      } else {
        setFormError('Sin conexión con Lumon. Vuelve a enviarlo.')
      }
    } finally {
      setSending(false)
    }
  }

  const input = 'mt-1 w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5'

  return (
    <section aria-labelledby="new-incident-title" className="max-w-2xl space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 id="new-incident-title" className="text-2xl font-bold">
          Reportar incidencia
        </h1>
        <Link to="/incidents" className="ml-auto text-sm text-sky-300 underline">
          Volver a incidencias
        </Link>
      </div>

      <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
        <label className="block text-sm">
          Título
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            minLength={3}
            maxLength={120}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? 'err-title' : undefined}
            className={input}
          />
          {errors.title && (
            <span id="err-title" className="text-rose-300">
              {errors.title}
            </span>
          )}
        </label>
        <label className="block text-sm">
          Descripción
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
            rows={4}
            required
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={errors.description ? 'err-description' : undefined}
            className={input}
          />
          {errors.description && (
            <span id="err-description" className="text-rose-300">
              {errors.description}
            </span>
          )}
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            Gravedad
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={input}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Archivo relacionado (id, opcional)
            <input inputMode="numeric" value={fileId} onChange={(e) => setFileId(e.target.value)} className={input} />
          </label>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm">Fotos (de 1 a 3)</legend>
          {photos.length < MAX_PHOTOS && (
            <input type="file" accept="image/*" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} className="block text-sm" />
          )}
          <ul className="space-y-2">
            {photos.map((p) => (
              <PhotoRow
                key={p.key}
                photo={p}
                onRemove={() => removePhoto(p.key)}
                onState={(mediaId) =>
                  setConfirmed((prev) => {
                    if (mediaId === null) {
                      if (prev[p.key] === undefined) return prev
                      const next = { ...prev }
                      delete next[p.key]
                      return next
                    }
                    return prev[p.key] === mediaId ? prev : { ...prev, [p.key]: mediaId }
                  })
                }
              />
            ))}
          </ul>
        </fieldset>

        {formError && (
          <p role="alert" className="text-sm text-rose-300">
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={!allConfirmed || sending || title.trim().length < 3 || description.trim() === ''}
          className="rounded-md bg-sky-700 px-4 py-2 font-semibold hover:bg-sky-600 disabled:opacity-60"
        >
          {sending ? 'Enviando…' : 'Enviar reporte'}
        </button>
        {!allConfirmed && photos.length > 0 && <p className="text-xs text-slate-400">Se puede enviar cuando todas las fotos estén confirmadas.</p>}
      </form>
    </section>
  )
}
