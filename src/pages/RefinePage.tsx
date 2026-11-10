import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import {
  backoffMs,
  BIN_CHAR,
  BINS,
  getFile,
  getRules,
  isAbort,
  sleep,
  type Bin,
  type Cell,
  type DataFile,
  type RefineResult,
  type Rules,
} from '../api/files'
import { useAuth } from '../auth/context'
import { Grid } from '../features/refine/Grid'
import { findGroup, type Group } from '../features/refine/groups'
import { TileStore } from '../features/refine/tileStore'

const BIN_NAME: Record<Bin, string> = { WO: 'WO', FC: 'FC', DR: 'DR', MA: 'MA' }
const BIN_STYLE: Record<Bin, string> = {
  WO: 'border-teal-500 bg-teal-950',
  FC: 'border-lime-500 bg-lime-950',
  DR: 'border-rose-500 bg-rose-950',
  MA: 'border-violet-500 bg-violet-950',
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; file: DataFile; rules: Rules }

type Msg = { kind: 'ok' | 'error' | 'info'; text: string } | null

const GROUP_REASON: Record<string, string> = {
  BELOW_THRESHOLD: 'El grupo incluye celdas que no dan miedo.',
  NOT_CONNECTED: 'Las celdas no forman un solo grupo conexo.',
  INCOMPLETE: 'Al grupo le faltan celdas.',
  SIZE_OUT_OF_RANGE: 'Ese grupo es ruido: su tamaño está fuera del rango permitido.',
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parseCell(params: URLSearchParams, rows: number, cols: number): Cell {
  const r = Number(params.get('r') ?? '0')
  const c = Number(params.get('c') ?? '0')
  return {
    r: Number.isInteger(r) ? Math.min(Math.max(0, r), rows - 1) : 0,
    c: Number.isInteger(c) ? Math.min(Math.max(0, c), cols - 1) : 0,
  }
}

export default function RefinePage() {
  const { id: idParam } = useParams()
  const fileId = Number(idParam)
  const validId = Number.isInteger(fileId) && fileId > 0
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const canRefine = can('files:refine')

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reloadTick, setReloadTick] = useState(0)
  const [store, setStore] = useState<TileStore | null>(null)
  const [group, setGroup] = useState<Group | null>(null)
  const [searching, setSearching] = useState(false)
  const [refining, setRefining] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)

  const searchCtl = useRef<AbortController | null>(null)
  const busy = useRef(false)
  /** Una Idempotency-Key por intención (grupo + caja). Reintentar la misma intención reusa la key. */
  const intents = useRef(new Map<string, string>())

  useEffect(() => {
    if (!validId) {
      setLoad({ status: 'error', message: 'El identificador del archivo no es válido.', notFound: true })
      return
    }
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    Promise.all([getFile(fileId, controller.signal), getRules(fileId, controller.signal)])
      .then(([file, rules]) => setLoad({ status: 'ready', file, rules }))
      .catch((err: unknown) => {
        if (isAbort(err)) return
        const notFound = err instanceof ApiError && err.status === 404
        setLoad({
          status: 'error',
          notFound,
          message: notFound ? 'Ese archivo no existe.' : err instanceof ApiError ? err.message : 'No se pudo conectar con Lumon.',
        })
      })
    return () => controller.abort()
  }, [fileId, validId, reloadTick])

  const ready = load.status === 'ready' ? load : null
  const rows = ready?.file.rows ?? 0
  const cols = ready?.file.cols ?? 0
  const tileSize = ready?.file.tileSize ?? 0

  // El store se crea una vez por archivo (no por cada cambio de progreso).
  useEffect(() => {
    if (rows === 0 || cols === 0 || tileSize === 0) return
    const s = new TileStore(fileId, rows, cols, tileSize)
    setStore(s)
    return () => {
      s.dispose()
      searchCtl.current?.abort()
      setStore(null)
      setGroup(null)
    }
  }, [fileId, rows, cols, tileSize])

  // Posición inicial desde la URL, leída una sola vez por store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => (store ? parseCell(params, rows, cols) : { r: 0, c: 0 }), [store])

  const onPositionChange = useCallback(
    (cell: Cell) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('r', String(cell.r))
          next.set('c', String(cell.c))
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const rules = ready?.rules ?? null

  const onActivate = useCallback(
    (cell: Cell) => {
      if (!store || !rules) return
      searchCtl.current?.abort()
      const ctl = new AbortController()
      searchCtl.current = ctl
      setSearching(true)
      setMsg(null)
      findGroup(store, rules, rows, cols, cell, ctl.signal)
        .then((g) => {
          if (ctl.signal.aborted) return
          setGroup(g)
          if (g === null) setMsg({ kind: 'info', text: 'Esa celda no da miedo.' })
        })
        .catch((err: unknown) => {
          if (isAbort(err) || ctl.signal.aborted) return
          setMsg({ kind: 'error', text: 'No se pudo cargar el grupo completo. Vuelve a intentarlo.' })
        })
        .finally(() => {
          if (searchCtl.current === ctl) setSearching(false)
        })
    },
    [store, rules, rows, cols],
  )

  const refine = useCallback(
    async (bin: Bin) => {
      if (!store || !group || busy.current) return
      if (!canRefine) {
        setMsg({ kind: 'error', text: 'No tienes permiso para refinar.' })
        return
      }
      if (group.refinedAs !== null) {
        setMsg({ kind: 'info', text: 'Ese grupo ya está refinado.' })
        return
      }
      if (group.noise) {
        setMsg({ kind: 'error', text: 'Ese grupo es ruido: no se puede refinar.' })
        return
      }
      busy.current = true
      setRefining(true)
      setMsg({ kind: 'info', text: `Llevando el grupo a ${bin}…` })

      const intentId = `${bin}|${[...group.keys].sort((a, b) => a - b).join(',')}`
      let key = intents.current.get(intentId)
      if (key === undefined) {
        key = crypto.randomUUID()
        intents.current.set(intentId, key)
      }

      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const { data } = await apiRequest<RefineResult>(`/files/${fileId}/refinements`, {
              method: 'POST',
              headers: { 'Idempotency-Key': key },
              json: { bin, cells: group.cells },
            })
            store.markRefined(group.cells, BIN_CHAR[bin])
            setLoad((prev) => (prev.status === 'ready' ? { ...prev, file: { ...prev.file, ...data.file } } : prev))
            setGroup(null)
            setMsg({ kind: 'ok', text: `Grupo de ${data.size} celdas refinado en ${bin}.` })
            return
          } catch (err) {
            // Reintento de red / 503 / 429 con la MISMA key: nunca refina dos veces.
            const transient =
              err instanceof TypeError || (err instanceof ApiError && (err.status === 503 || err.status === 429))
            if (transient && attempt < 6) {
              setMsg({ kind: 'info', text: 'Lumon no respondió. Reintentando con la misma solicitud…' })
              await sleep(backoffMs(attempt, err instanceof ApiError ? err.retryAfter : null))
              continue
            }
            throw err
          }
        }
      } catch (err) {
        if (!(err instanceof ApiError)) {
          setMsg({ kind: 'error', text: 'Sin conexión con Lumon. Vuelve a soltar el grupo en la caja para reintentar.' })
          return
        }
        const d = err.details
        switch (err.code) {
          case 'WRONG_BIN': {
            const mistakes = isRecord(d) && typeof d.mistakes === 'number' ? d.mistakes : null
            if (mistakes !== null)
              setLoad((prev) => (prev.status === 'ready' ? { ...prev, file: { ...prev.file, mistakes } } : prev))
            setMsg({ kind: 'error', text: `${bin} no es la caja correcta para este grupo. Revisa las reglas y elige otra.` })
            break
          }
          case 'ALREADY_REFINED': {
            const tiles = isRecord(d) && Array.isArray(d.tiles) ? (d.tiles as [number, number][]) : []
            store.invalidate(tiles)
            setGroup(null)
            setMsg({ kind: 'error', text: 'Alguien ya refinó parte de este grupo. Actualizamos los bloques: vuelve a elegirlo.' })
            break
          }
          case 'GROUP_CLAIMED': {
            const holder = isRecord(d) && isRecord(d.holder) && typeof d.holder.displayName === 'string' ? d.holder.displayName : 'otro refinador'
            setMsg({ kind: 'error', text: `${holder} tiene reservado este grupo. Espera a que lo libere o elige otro.` })
            break
          }
          case 'GROUP_INVALID': {
            const reason = isRecord(d) && typeof d.reason === 'string' ? d.reason : ''
            const missing = isRecord(d) && typeof d.missing === 'number' ? ` (faltan ${d.missing})` : ''
            setMsg({ kind: 'error', text: `${GROUP_REASON[reason] ?? err.message}${missing} Vuelve a seleccionar el grupo.` })
            setGroup(null)
            break
          }
          default:
            setMsg({ kind: 'error', text: err.message })
        }
      } finally {
        busy.current = false
        setRefining(false)
      }
    },
    [store, group, canRefine, fileId],
  )

  const onBinKey = useCallback(
    (index: number) => {
      const bin = BINS[index]
      if (bin) void refine(bin)
    },
    [refine],
  )
  const onEscape = useCallback(() => setGroup(null), [])
  const onDrop = useCallback((bin: Bin) => void refine(bin), [refine])

  if (load.status === 'loading') return <p role="status">Abriendo archivo…</p>
  if (load.status === 'error') {
    return (
      <div role="alert" className="space-y-3">
        <p>{load.message}</p>
        {!load.notFound && (
          <button type="button" onClick={() => setReloadTick((t) => t + 1)} className="rounded-md bg-sky-700 px-3 py-1 hover:bg-sky-600">
            Reintentar
          </button>
        )}
        <Link to="/files" className="block text-sky-300 underline">
          Volver a los archivos
        </Link>
      </div>
    )
  }

  const { file } = load
  const complete = file.status === 'COMPLETE' || file.progress.overall >= 1

  if (complete) {
    return (
      <section className="mx-auto max-w-xl py-12 text-center" aria-labelledby="done-title">
        <h1 id="done-title" className="text-3xl font-bold">
          Archivo completado
        </h1>
        <p className="mt-3 text-slate-300">
          «{file.name}» llegó al 100 %. {file.refinedGroups} grupos refinados, {file.mistakes} errores.
        </p>
        <p className="mt-2 italic text-slate-400">Que cada número encuentre su caja.</p>
        <Link to="/files" className="mt-6 inline-block rounded-md bg-sky-700 px-4 py-2 hover:bg-sky-600">
          Volver a los archivos
        </Link>
      </section>
    )
  }

  const groupBin = group?.bin ?? null

  return (
    <section aria-labelledby="refine-title" className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 id="refine-title" className="text-2xl font-bold">
          {file.name}
        </h1>
        <span className="text-sm text-slate-400">
          {file.rows} × {file.cols} · {file.refinedGroups}/{file.totalGroups} grupos · {file.mistakes} errores
        </span>
        <Link to="/files" className="ml-auto text-sm text-sky-300 underline">
          Volver a los archivos
        </Link>
      </div>

      <p className="text-xs text-slate-400">
        Reglas: da miedo con temblor ≥ {load.rules.tremorThreshold} · conectividad {load.rules.connectivity} · grupos de{' '}
        {load.rules.minGroupSize} a {load.rules.maxGroupSize} celdas ·{' '}
        {load.rules.binning.strategy === 'DIGIT_SUM_MOD' ? 'suma de dígitos' : 'dígito máximo'} % 4 →{' '}
        {load.rules.binning.order.join(', ')}
      </p>

      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div>
          {store ? (
            <Grid
              store={store}
              rows={file.rows}
              cols={file.cols}
              rules={load.rules}
              selected={group?.keys ?? null}
              draggable={canRefine && group !== null && !group.noise && group.refinedAs === null}
              initial={initial}
              onActivate={onActivate}
              onBinKey={onBinKey}
              onEscape={onEscape}
              onDrop={onDrop}
              onPositionChange={onPositionChange}
            />
          ) : (
            <p role="status">Preparando la grilla…</p>
          )}
          {store?.status && (
            <p role="status" className="mt-2 text-sm text-amber-300">
              {store.status}
            </p>
          )}
          <p className="mt-2 text-xs text-slate-400">
            Teclado: flechas, RePág/AvPág, Inicio/Fin para moverse · Enter elige el grupo · 1–4 lo lleva a WO, FC, DR o MA
            · Esc cancela. Con el mouse: clic en una celda que tiembla y arrastra el grupo a una caja.
          </p>
        </div>

        <aside className="space-y-3" aria-label="Grupo y cajas">
          <div className="rounded-md border border-slate-700 p-3" aria-live="polite">
            <h2 className="font-semibold">Grupo seleccionado</h2>
            {searching ? (
              <p className="text-sm text-slate-300">Buscando el grupo completo…</p>
            ) : group ? (
              <ul className="mt-1 text-sm">
                <li>Tamaño: {group.truncated ? `más de ${load.rules.maxGroupSize}` : group.size} celdas</li>
                <li>
                  {group.refinedAs !== null
                    ? `Ya refinado (${group.refinedAs})`
                    : group.noise
                      ? 'Es ruido: no se puede refinar'
                      : `Caja según las reglas: ${groupBin}`}
                </li>
              </ul>
            ) : (
              <p className="text-sm text-slate-400">Ninguno. Elige una celda que tiembla.</p>
            )}
          </div>

          {msg && (
            <p
              role={msg.kind === 'error' ? 'alert' : 'status'}
              className={`rounded-md p-2 text-sm ${msg.kind === 'error' ? 'bg-rose-950 text-rose-200' : msg.kind === 'ok' ? 'bg-emerald-950 text-emerald-200' : 'bg-slate-800 text-slate-200'}`}
            >
              {msg.text}
            </p>
          )}

          <ul className="space-y-2" aria-label="Cajas">
            {BINS.map((bin, i) => (
              <li key={bin}>
                <button
                  type="button"
                  data-bin={bin}
                  disabled={!canRefine || refining || !group || group.noise || group.refinedAs !== null}
                  onClick={() => void refine(bin)}
                  aria-keyshortcuts={String(i + 1)}
                  aria-label={`Llevar el grupo a ${BIN_NAME[bin]} (tecla ${i + 1}). Progreso ${Math.round(file.progress[bin] * 100)} %`}
                  className={`w-full rounded-md border-2 p-2 text-left transition data-[drop-target=true]:scale-105 data-[drop-target=true]:ring-4 data-[drop-target=true]:ring-sky-400 disabled:cursor-not-allowed ${BIN_STYLE[bin]}`}
                >
                  <span className="flex justify-between font-semibold">
                    <span>
                      {bin} <span className="text-xs text-slate-400">[{i + 1}]</span>
                    </span>
                    <span>{Math.round(file.progress[bin] * 100)} %</span>
                  </span>
                  <progress className="mt-1 w-full" max={1} value={file.progress[bin]} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {!canRefine && <p className="text-sm text-slate-400">Tu rol solo puede ver la grilla.</p>}
          <p className="text-sm">Progreso total: {Math.round(file.progress.overall * 100)} %</p>
        </aside>
      </div>
    </section>
  )
}
