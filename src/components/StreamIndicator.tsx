import { useStreamStatus } from '../realtime/useEvents'

const LABEL = {
  idle: 'Eventos: inactivo',
  connecting: 'Eventos: conectando…',
  open: 'Eventos: en vivo',
  reconnecting: 'Eventos: reconectando…',
  closed: 'Eventos: sin conexión',
} as const

const DOT = {
  idle: 'bg-slate-500',
  connecting: 'bg-amber-400',
  open: 'bg-emerald-400',
  reconnecting: 'bg-amber-400',
  closed: 'bg-rose-500',
} as const

/** Indicador visible del estado de la conexión al stream de eventos. */
export function StreamIndicator() {
  const { status, leader, message } = useStreamStatus()
  return (
    <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-slate-300" title={message ?? undefined}>
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT[status]}`} />
      {LABEL[status]}
      {status === 'open' && !leader && <span className="text-slate-500">(compartido)</span>}
    </span>
  )
}
