import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/errors'
import { isAbort } from '../api/files'
import { getDepartments, getRefiners, safeHttpUrl, type Department, type Refiner, type RefinerPage } from '../api/refiners'
import { useAuth } from '../auth/context'
import { isRecord, useLumonEvent } from '../realtime/useEvents'

const SIZES = [10, 25, 50] as const

interface Query {
  page: number
  size: number
  departmentId: number | null
  q: string
}

/** Sanea la URL: cualquier valor inválido vuelve a su valor por defecto (la vista nunca se rompe). */
function parseQuery(params: URLSearchParams): Query {
  const pageRaw = Number(params.get('page') ?? '0')
  const sizeRaw = Number(params.get('size') ?? '10')
  const depRaw = Number(params.get('departmentId') ?? '')
  return {
    page: Number.isInteger(pageRaw) && pageRaw >= 0 ? pageRaw : 0,
    size: (SIZES as readonly number[]).includes(sizeRaw) ? sizeRaw : 10,
    departmentId: params.has('departmentId') && Number.isInteger(depRaw) && depRaw >= 1 ? depRaw : null,
    q: (params.get('q') ?? '').slice(0, 60),
  }
}

function toParams(q: Query): URLSearchParams {
  const p = new URLSearchParams()
  if (q.page !== 0) p.set('page', String(q.page))
  if (q.size !== 10) p.set('size', String(q.size))
  if (q.departmentId !== null) p.set('departmentId', String(q.departmentId))
  if (q.q !== '') p.set('q', q.q)
  return p
}

type Load = { status: 'loading' } | { status: 'ok'; data: RefinerPage } | { status: 'error'; message: string }

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'CLEARANCE_REQUIRED') return 'El Piso de Pruebas todavía no está abierto.'
  return err instanceof ApiError ? err.message : 'No se pudo conectar con Lumon.'
}

/** Fotocheck con tamaño fijo reservado: al cargar la imagen el layout no se mueve. */
function BadgeThumb({ refiner }: { refiner: Refiner }) {
  const box = 'h-16 w-16 shrink-0 rounded-md'
  if (!refiner.badge) {
    return (
      <div className={`${box} grid place-items-center bg-slate-800 text-xs text-slate-400`} aria-hidden="true">
        Sin foto
      </div>
    )
  }
  return (
    <img
      src={refiner.badge.url}
      width={refiner.badge.width}
      height={refiner.badge.height}
      loading="lazy"
      decoding="async"
      alt={`Fotocheck de ${refiner.fullName}`}
      className={`${box} bg-slate-800 object-cover`}
    />
  )
}

export default function RefinersPage() {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => parseQuery(params), [params])
  const canonical = toParams(query).toString()
  const { can } = useAuth()
  const canEditBadge = can('refiners:write') && can('media:upload')

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [departments, setDepartments] = useState<Department[] | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [search, setSearch] = useState(query.q)
  const lastRequest = useRef(0)

  // URL inválida → se reescribe a su forma canónica sin agregar entrada al historial.
  useEffect(() => {
    if (params.toString() !== canonical) setParams(new URLSearchParams(canonical), { replace: true })
  }, [params, canonical, setParams])

  // Atrás/adelante cambia la URL: el input de búsqueda la sigue.
  useEffect(() => setSearch(query.q), [query.q])

  // Búsqueda sin una request por tecla: espera 350 ms sin escribir.
  useEffect(() => {
    if (search.slice(0, 60) === query.q) return
    const t = window.setTimeout(() => {
      setParams(toParams({ ...query, q: search.slice(0, 60), page: 0 }), { replace: true })
    }, 350)
    return () => window.clearTimeout(t)
  }, [search, query, setParams])

  // Departamentos para el filtro (los códigos cambian entre workspaces: nada hardcodeado).
  useEffect(() => {
    const controller = new AbortController()
    getDepartments(controller.signal)
      .then(setDepartments)
      .catch(() => setDepartments([]))
    return () => controller.abort()
  }, [reloadTick])

  useEffect(() => {
    const controller = new AbortController()
    const id = ++lastRequest.current
    const apiParams = new URLSearchParams({ page: String(query.page), size: String(query.size) })
    if (query.departmentId !== null) apiParams.set('departmentId', String(query.departmentId))
    if (query.q !== '') apiParams.set('q', query.q)
    setLoad((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }))
    getRefiners(apiParams, controller.signal)
      .then((data) => {
        // Una respuesta vieja nunca pisa a una nueva.
        if (id === lastRequest.current) setLoad({ status: 'ok', data })
      })
      .catch((err: unknown) => {
        if (isAbort(err) || id !== lastRequest.current) return
        setLoad({ status: 'error', message: errorText(err) })
      })
    return () => controller.abort()
  }, [query, reloadTick])

  // Eventos en vivo: un expediente cambió. Solo se aplica si es una versión MÁS NUEVA.
  useLumonEvent('refiner.updated', (e) => {
    const d = e.data
    if (!isRecord(d)) return
    const fresh = isRecord(d.refiner) ? d.refiner : d
    if (typeof fresh.id !== 'number' || typeof fresh.version !== 'number') return
    const id = fresh.id
    const version = fresh.version
    setLoad((prev) => {
      if (prev.status !== 'ok') return prev
      const content = prev.data.content.map((r) => (r.id === id && version > r.version ? ({ ...r, ...fresh } as Refiner) : r))
      return { status: 'ok', data: { ...prev.data, content } }
    })
  })
  // El servidor no pudo reenviar lo perdido: se vuelve a pedir la página, sin recargar.
  useLumonEvent('stream.reset', () => setReloadTick((t) => t + 1))

  const update = (patch: Partial<Query>) => setParams(toParams({ ...query, page: 0, ...patch }))

  const data = load.status === 'ok' ? load.data : null
  const totalPages = data?.totalPages ?? 0

  return (
    <section aria-labelledby="refiners-title">
      <h1 id="refiners-title" className="text-2xl font-bold">
        Personal
      </h1>

      <form className="mt-4 flex flex-wrap items-end gap-3" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="flex flex-col text-sm">
          Buscar (nombre, cargo o anexo)
          <input
            type="search"
            value={search}
            maxLength={60}
            onChange={(e) => setSearch(e.target.value)}
            className="mt-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          Departamento
          <select
            value={query.departmentId ?? ''}
            onChange={(e) => update({ departmentId: e.target.value === '' ? null : Number(e.target.value) })}
            className="mt-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          >
            <option value="">Todos</option>
            {departments?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
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
        {load.status === 'loading' && <p role="status">Cargando expedientes…</p>}
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
              <p>No hay expedientes con esos filtros.</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {data.content.map((r) => {
                  const profile = safeHttpUrl(r.profileUrl)
                  return (
                    <li key={r.id} className="flex gap-3 rounded-md border border-slate-800 p-3">
                      <BadgeThumb refiner={r} />
                      <div className="min-w-0 flex-1 text-sm">
                        {/* Texto plano: React escapa todo lo que va entre llaves. */}
                        <h2 className="truncate text-base font-semibold">{r.fullName}</h2>
                        <p className="text-slate-300">
                          {r.title} · {r.department.name} · anexo {r.extension}
                        </p>
                        <p className="mt-1 line-clamp-2 whitespace-pre-line text-slate-400">{r.bio}</p>
                        <p className="mt-2 flex flex-wrap gap-3">
                          {profile && (
                            <a href={profile} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">
                              Perfil<span className="sr-only"> de {r.fullName}</span>
                            </a>
                          )}
                          {can('refiners:write') && (
                            <Link to={`/refiners/${r.id}/edit`} className="text-sky-300 underline">
                              Editar<span className="sr-only"> el expediente de {r.fullName}</span>
                            </Link>
                          )}
                          {canEditBadge && (
                            <Link to={`/refiners/${r.id}/badge`} className="text-sky-300 underline">
                              Cambiar fotocheck<span className="sr-only"> de {r.fullName}</span>
                            </Link>
                          )}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ul>
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
                Página {query.page + 1} de {Math.max(totalPages, 1)} · {data.totalElements} expedientes
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
