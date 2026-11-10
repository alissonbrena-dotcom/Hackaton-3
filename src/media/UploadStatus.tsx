import { useSyncExternalStore } from 'react'
import type { UploadJob, UploadState } from './upload'

/** Suscribe un componente al estado de una subida (se re-renderiza con cada cambio de progreso). */
export function useUploadState(job: UploadJob): UploadState {
  return useSyncExternalStore(job.subscribe, job.getState)
}

const noop = () => () => undefined
const none = () => null

/** Igual que useUploadState pero acepta "todavía no hay subida" (null). */
export function useMaybeUploadState(job: UploadJob | null): UploadState | null {
  return useSyncExternalStore(job ? job.subscribe : noop, job ? job.getState : none)
}

const PHASE_TEXT: Record<UploadState['phase'], string> = {
  idle: 'Lista para subir',
  ticket: 'Pidiendo permiso a Lumon…',
  uploading: 'Subiendo…',
  confirming: 'Lumon está comprobando la imagen…',
  done: 'Imagen confirmada',
  error: 'Error',
  cancelled: 'Subida cancelada',
}

/** Barra de progreso real + cancelar + reintentar. */
export function UploadStatus({ job, label }: { job: UploadJob; label: string }) {
  const s = useUploadState(job)
  const running = s.phase === 'ticket' || s.phase === 'uploading' || s.phase === 'confirming'
  const pct = Math.round(s.progress * 100)
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          {PHASE_TEXT[s.phase]}
          {s.phase === 'uploading' ? ` ${pct} %` : ''}
        </span>
        <span className="flex gap-2">
          {running && (
            <button type="button" onClick={() => job.cancel()} className="rounded-md border border-slate-600 px-2 py-0.5 hover:bg-slate-800">
              Cancelar<span className="sr-only"> {label}</span>
            </button>
          )}
          {(s.phase === 'error' || s.phase === 'cancelled') && (
            <button type="button" onClick={() => void job.run()} className="rounded-md bg-sky-700 px-2 py-0.5 hover:bg-sky-600">
              Reintentar<span className="sr-only"> {label}</span>
            </button>
          )}
        </span>
      </div>
      <progress className="w-full" max={100} value={s.phase === 'done' ? 100 : pct} aria-label={`Progreso de ${label}`} />
      {s.error && (
        <p role="alert" className="text-rose-300">
          {s.error}
        </p>
      )}
    </div>
  )
}
