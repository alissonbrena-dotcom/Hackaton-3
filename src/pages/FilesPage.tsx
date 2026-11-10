import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/errors'
import { getWithRetry, isAbort, type FilePage, type FileStatus } from '../api/files'

const SIZES = [10, 25, 50] as const
const SORTS = [
  { value: 'updatedAt,desc', label: 'Actualizados recientemente' },
  { value: 'progress,desc', label: 'Mayor progreso' },
  { value: 'name,asc', label: 'Nombre (A-Z)' },
] as const
const STATUSES: readonly FileStatus[] = ['ACTIVE', 'COMPLETE']

interface Query {
  page: number
  size: number
  status: FileStatus | ''
  q: string
  sort: string
}

/** Sanea la URL: cualquier valor inválido vuelve a su valor por defecto (la vista nunca se rompe). */
function parseQuery(params: URLSearchParams): Query {
  const pageRaw = Number(params.get('page') ?? '0')
  const page = Number.isInteger(pageRaw) && pageRaw >= 0 ? pageRaw : 0
  const sizeRaw = Number(params.get('size') ?? '10')
  const size = (SIZES as readonly number[]).includes(sizeRaw) ? sizeRaw : 10
  const statusRaw = params.get('status') ?? ''
  const status = (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as FileStatus) : ''
  const q = (params.get('q') ?? '').slice(0, 60)
  const sortRaw = params.get('sort') ?? 'updatedAt,desc'
  const sort = SORTS.some((s) => s.value === sortRaw) ? sortRaw : 'updatedAt,desc'
  return { page, size, status, q, sort }
}

function toParams(q: Query): URLSearchParams {
  const p = new URLSearchParams()
  if (q.page !== 0) p.set('page', String(q.page))
  if (q.size !== 10) p.set('size', String(q.size))
  if (q.status !== '') p.set('status', q.status)
  if (q.q !== '') p.set('q', q.q)
  if (q.sort !== 'updatedAt,desc') p.set('sort', q.sort)
  return p
}

type Load = { status: 'loading' } | { status: 'ok'; data: FilePage } | { status: 'error'; message: string }

const pct = (n: number) => `${Math.round(n * 100)} %`

export default function FilesPage() {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => parseQuery(params), [params])
  const canonical = toParams(query).toString()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [search, setSearch] = useState(query.q)
  const lastRequest = useRef(0)

  // URL inválida → se reescribe a su forma canónica sin agregar entrada al historial.
  useEffect(() => {
    if (params.toString() !== canonical) setParams(new URLSearchParams(canonical), { replace: true })
  }, [params, canonical, setParams])

  // Atrás/adelante cambia la URL: el input de búsqueda la sigue.
  useEffect(() => setSearch(query.q), [query.q])

  // Búsqueda sin una request por tecla: espera 350 ms de inactividad.
  useEffect(() => {
    if (search.slice(0, 60) === query.q) return
    const t = window.setTimeout(() => {
      setParams(toParams({ ...query, q: search.slice(0, 60), page: 0 }), { replace: true })
    }, 350)
    return () => window.clearTimeout(t)
  }, [search, query, setParams])

  useEffect(() => {
    const controller = new AbortController()
    const id = ++lastRequest.current
    const apiParams = new URLSearchParams({ page: String(query.page), size: String(query.size), sort: query.sort })
    if (query.status !== '') apiParams.set('status', query.status)
    if (query.q !== '') apiParams.set('q', query.q)
    setLoad((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }))
    getWithRetry<FilePage>(`/files?${apiParams.toString()}`, controller.signal)
      .then((data) => {
        // Una respuesta vieja nunca pisa a una nueva.
        if (id === lastRequest.current) setLoad({ status: 'ok', data })
      })
      .catch((err: unknown) => {
        if (isAbort(err) || id !== lastRequest.current) return
        setLoad({ status: 'error', message: err instanceof ApiError ? err.message : 'No se pudo conectar con Lumon.' })
      })
    return () => controller.abort()
  }, [query, reloadTick])

  const update = (patch: Partial<Query>) => setParams(toParams({ ...query, page: 0, ...patch }))

  const data = load.status === 'ok' ? load.data : null
  const totalPages = data?.totalPages ?? 0

  return (
    <section aria-labelledby="files-title">
      <h1 id="files-title" className="text-2xl font-bold">
        Archivos de datos
      </h1>

      <form className="mt-4 flex flex-wrap items-end gap-3" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="flex flex-col text-sm">
          Buscar
          <input
            type="search"
            value={search}
            maxLength={60}
            onChange={(e) => setSearch(e.target.value)}
            className="mt-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          Estado
          <select
            value={query.status}
            onChange={(e) => update({ status: e.target.value as Query['status'] })}
            className="mt-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          >
            <option value="">Todos</option>
            <option value="ACTIVE">Activos</option>
            <option value="COMPLETE">Completados</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Orden
          <select
            value={query.sort}
            onChange={(e) => update({ sort: e.target.value })}
            className="mt-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Por página
          <select
            value={query.size}
            onChange={(e) => update({ size: Number(e.target.value) })}
            className="mt-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </form>

      <div className="mt-4" aria-live="polite" aria-busy={load.status === 'loading'}>
        {load.status === 'loading' && <p role="status">Cargando archivos…</p>}
        {load.status === 'error' && (
          <div role="alert" className="rounded-md border border-rose-700 bg-rose-950/50 p-3">
            <p>{load.message}</p>
            <button
              type="button"
              onClick={() => setReloadTick((t) => t + 1)}
              className="mt-2 rounded-md bg-sky-700 px-3 py-1 hover:bg-sky-600"
            >
              Reintentar
            </button>
          </div>
        )}
        {data !== null && (
          <>
            {data.content.length === 0 ? (
              <p>No hay archivos con esos filtros.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Archivos de datos, página {data.page + 1} de {Math.max(totalPages, 1)}</caption>
                <thead className="border-b border-slate-700 text-slate-300">
                  <tr>
                    <th scope="col" className="py-2">Nombre</th>
                    <th scope="col">Tamaño</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Progreso</th>
                    <th scope="col">Errores</th>
                    <th scope="col"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.content.map((f) => (
                    <tr key={f.id} className="border-b border-slate-800">
                      <td className="py-2 font-medium">{f.name}</td>
                      <td>{f.rows} × {f.cols}</td>
                      <td>{f.status === 'COMPLETE' ? 'Completado' : 'Activo'}</td>
                      <td>
                        <progress className="mr-2 align-middle" max={1} value={f.progress.overall} aria-label={`Progreso de ${f.name}`} />
                        {pct(f.progress.overall)}
                      </td>
                      <td>{f.mistakes}</td>
                      <td>
                        <Link to={`/files/${f.id}/refine`} className="text-sky-300 underline">
                          Refinar<span className="sr-only"> {f.name}</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <nav aria-label="Paginación" className="mt-4 flex items-center gap-3">
              <button
                type="button"
                disabled={query.page <= 0}
                onClick={() => setParams(toParams({ ...query, page: query.page - 1 }))}
                className="rounded-md border border-slate-600 px-3 py-1 disabled:opacity-50"
              >
                Anterior
              </button>
              <span>
                Página {query.page + 1} de {Math.max(totalPages, 1)} · {data.totalElements} archivos
              </span>
              <button
                type="button"
                disabled={query.page + 1 >= totalPages}
                onClick={() => setParams(toParams({ ...query, page: query.page + 1 }))}
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
