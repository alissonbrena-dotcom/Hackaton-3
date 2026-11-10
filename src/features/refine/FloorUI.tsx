import { useSyncExternalStore } from 'react'
import type { Cell } from '../../api/files'
import type { FloorClient, FloorStatus } from '../../realtime/floor'
import { CELL } from './Grid'

const COLORS = ['#f472b6', '#38bdf8', '#a3e635', '#fbbf24', '#c084fc', '#fb7185', '#2dd4bf']
const colorFor = (userId: number) => COLORS[userId % COLORS.length]

/**
 * Cursores de los demás, dibujados sobre la grilla. Se suscribe solo a los cursores:
 * cuando llegan, se re-renderiza esta capa, no la grilla.
 */
export function CursorLayer({ floor }: { floor: FloorClient }) {
  useSyncExternalStore(floor.subscribeCursors, floor.getCursorVersion)
  const me = floor.myUserId
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {[...floor.members.values()]
        .filter((m) => m.userId !== me && m.r !== null && m.c !== null)
        .map((m) => (
          <div
            key={m.userId}
            className="absolute transition-transform duration-100 motion-reduce:transition-none"
            style={{ transform: `translate(${(m.c ?? 0) * CELL}px, ${(m.r ?? 0) * CELL}px)`, width: CELL, height: CELL }}
          >
            <div className="h-full w-full rounded-sm border-2" style={{ borderColor: colorFor(m.userId) }} />
            <span
              className="absolute left-full top-0 ml-0.5 whitespace-nowrap rounded px-1 text-[10px] font-semibold text-slate-950"
              style={{ background: colorFor(m.userId) }}
            >
              {m.displayName}
            </span>
          </div>
        ))}
    </div>
  )
}

const STATUS_LABEL: Record<FloorStatus, string> = {
  connecting: 'Piso: conectando…',
  open: 'Piso: conectado',
  reconnecting: 'Piso: reconectando…',
  closed: 'Piso: sin conexión',
}

/** Estado del WebSocket y lista de presentes (sin duplicados), con opción de ir a su posición. */
export function FloorPanel({
  floor,
  view,
  onGoTo,
}: {
  floor: FloorClient
  view: { r0: number; c0: number; rows: number; cols: number }
  onGoTo: (cell: Cell) => void
}) {
  useSyncExternalStore(floor.subscribeState, floor.getStateVersion)
  useSyncExternalStore(floor.subscribeCursors, floor.getCursorVersion)
  const members = [...floor.members.values()]
  const inView = (r: number | null, c: number | null) =>
    r !== null && c !== null && r >= view.r0 && r < view.r0 + view.rows && c >= view.c0 && c < view.c0 + view.cols

  return (
    <div className="rounded-md border border-slate-700 p-3 text-sm">
      <p role="status" aria-live="polite" className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${floor.status === 'open' ? 'bg-emerald-400' : floor.status === 'closed' ? 'bg-rose-500' : 'bg-amber-400'}`}
        />
        {STATUS_LABEL[floor.status]}
      </p>
      {floor.message && <p className="mt-1 text-xs text-amber-300">{floor.message}</p>}
      {floor.status === 'closed' && <p className="mt-1 text-xs text-slate-400">Puedes seguir refinando sin el piso compartido.</p>}
      <h2 className="mt-2 font-semibold">En el piso ({members.length})</h2>
      <ul className="mt-1 space-y-1">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colorFor(m.userId) }} />
            <span className="truncate">
              {m.displayName}
              {m.userId === floor.myUserId && ' (tú)'}
            </span>
            {m.userId !== floor.myUserId && m.r !== null && m.c !== null && !inView(m.r, m.c) && (
              <button
                type="button"
                onClick={() => onGoTo({ r: m.r ?? 0, c: m.c ?? 0 })}
                className="ml-auto rounded border border-slate-600 px-1.5 text-xs hover:bg-slate-800"
                aria-label={`Ir a la posición de ${m.displayName} (fila ${m.r + 1}, columna ${m.c + 1})`}
              >
                Ir ↗
              </button>
            )}
            {m.userId !== floor.myUserId && m.r !== null && inView(m.r, m.c) && (
              <span className="ml-auto text-xs text-slate-500">a la vista</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
