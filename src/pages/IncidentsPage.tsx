import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/errors'
import { isAbort } from '../api/files'
import { getIncidents, SEVERITY_LABEL, type IncidentPage } from '../api/incidents'
import { useAuth } from '../auth/context'

const SIZES = [10, 25, 50] as const

type Load = { status: 'loading' } | { status: 'ok'; data: IncidentPage } | { status: 'error'; message: string }

export default function IncidentsPage() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const page = useMemo(() => {
    const n = Number(params.get('page') ?? '0')
    return Number.isInteger(n) && n >= 0 ? n : 0
  }, [params])
  const size = useMemo(() => {
    const n = Number(params.get('size') ?? '10')
    return (SIZES as readonly number[]).includes(n) ? n : 10
  }, [params])
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  const last = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const id = ++last.current
    setLoad((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }))
    getIncidents(page, size, controller.signal)
      .then((data) => {
        if (id === last.current) setLoad({ status: 'ok', data })
      })
      .catch((err: unknown) => {
        if (isAbort(err) || id !== last.current) return
        const msg =
          err instanceof ApiError && err.code === 'CLEARANCE_REQUIRED'
            ? 'El Piso de Pruebas todavía no está abierto.'
            : err instanceof ApiError
              ? err.message
              : 'No se pudo conectar con Lumon.'
        setLoad({ status: 'error', message: msg })
      })
    return () => controller.abort()
  }, [page, size, tick])

  const go = (p: number) => {
    const next = new URLSearchParams()
    if (p > 0) next.set('page', String(p))
    if (size !== 10) next.set('size', String(size))
    setParams(next)
  }

  const data = load.status === 'ok' ? load.data : null

  return (
    <section aria-labelledby="incidents-title" className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 id="incidents-title" className="text-2xl font-bold">
          Incidencias
        </h1>
        {can('incidents:create') && (
          <Link to="/incidents/new" className="ml-auto rounded-md bg-sky-700 px-3 py-1.5 text-sm font-semibold hover:bg-sky-600">
            Reportar incidencia
          </Link>
        )}
      </div>

      <div aria-live="polite" aria-busy={load.status === 'loading'}>
        {load.status === 'loading' && <p role="status">Cargando incidencias…</p>}
        {load.status === 'error' && (
          <div role="alert" className="rounded-md border border-rose-700 bg-rose-950/50 p-3">
            <p>{load.message}</p>
            <button type="button" onClick={() => setTick((t) => t + 1)} className="mt-2 rounded-md bg-sky-700 px-3 py-1 hover:bg-sky-600">
              Reintentar
            </button>
          </div>
        )}
        {data && (
          <>
            {data.content.length === 0 ? (
              <p>No hay incidencias reportadas.</p>
            ) : (
              <ul className="space-y-3">
                {data.content.map((inc) => (
                  <li key={inc.id} className="rounded-md border border-slate-800 p-3">
                    {/* Textos del exterior: siempre como texto. */}
                    <h2 className="font-semibold">{inc.title}</h2>
                    <p className="text-sm text-slate-400">
                      Gravedad {SEVERITY_LABEL[inc.severity] ?? inc.severity}
                      {inc.file ? ` · ${inc.file.name}` : ''} · {inc.createdBy.displayName} · {new Date(inc.createdAt).toLocaleString()}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-sm">{inc.description}</p>
                    {inc.photos.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {inc.photos.map((p) => (
                          <li key={p.mediaId}>
                            {/* width/height reservan el espacio: el layout no salta al cargar. */}
                            <img
                              src={p.url}
                              width={p.width}
                              height={p.height}
                              loading="lazy"
                              decoding="async"
                              alt={`Foto de la incidencia «${inc.title}»`}
                              className="h-32 w-auto rounded-md bg-slate-800"
                              style={{ aspectRatio: `${p.width} / ${p.height}` }}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <nav aria-label="Paginación" className="mt-4 flex items-center gap-3">
              <button type="button" disabled={page <= 0} onClick={() => go(page - 1)} className="rounded-md border border-slate-600 px-3 py-1 disabled:opacity-50">
                Anterior
              </button>
              <span>
                Página {page + 1} de {Math.max(data.totalPages, 1)}
              </span>
              <button
                type="button"
                disabled={page + 1 >= data.totalPages}
                onClick={() => go(page + 1)}
                className="rounded-md border border-slate-600 px-3 py-1 disabled:opacity-50"
              >
                Siguiente
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  )
}
