import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { apiRequest } from '../api/client'
import { ApiError } from '../api/errors'
import { useAuth } from '../auth/context'
import { endSession } from '../auth/session'
import { startEvents } from '../realtime/events'
import { isRecord, useLumonEvent } from '../realtime/useEvents'

interface Contingency {
  id: number
  message: string
  createdAt: string
}

/**
 * Montado dentro del layout privado: mantiene el stream de eventos mientras hay sesión,
 * vuelve al login ante session.revoked y muestra las contingencias del usuario actual.
 */
export function RealtimeBridge() {
  const { state } = useAuth()
  const userId = state.status === 'authenticated' ? state.me.id : null
  const [queue, setQueue] = useState<Contingency[]>([])

  useEffect(() => {
    if (userId === null) return
    return startEvents()
  }, [userId])

  useLumonEvent('session.revoked', (e) => {
    const reason = isRecord(e.data) && e.data.reason === 'REFRESH_REUSED' ? 'REFRESH_REUSED' : 'SESSION_REVOKED'
    endSession(reason)
  })

  useLumonEvent('contingency.activated', (e) => {
    const d = e.data
    if (!isRecord(d) || typeof d.id !== 'number' || d.userId !== userId) return
    const item: Contingency = {
      id: d.id,
      message: typeof d.message === 'string' ? d.message : 'Contingencia de horas extra.',
      createdAt: typeof d.createdAt === 'string' ? d.createdAt : '',
    }
    setQueue((q) => (q.some((c) => c.id === item.id) ? q : [...q, item]))
  })

  useLumonEvent('contingency.resolved', (e) => {
    const d = e.data
    if (isRecord(d) && typeof d.id === 'number') setQueue((q) => q.filter((c) => c.id !== d.id))
  })

  const current = queue[0]
  if (!current) return null
  return <ContingencyModal key={current.id} contingency={current} onDone={(id) => setQueue((q) => q.filter((c) => c.id !== id))} />
}

function ContingencyModal({ contingency, onDone }: { contingency: Contingency; onDone: (id: number) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Foco al abrir, y se devuelve al cerrar.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    buttonRef.current?.focus()
    return () => previous?.focus()
  }, [])

  // El resto de la página queda inerte mientras el modal está abierto (el modal vive en un portal).
  useEffect(() => {
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    return () => root?.removeAttribute('inert')
  }, [])

  // Foco atrapado: Tab y Shift+Tab ciclan dentro del modal; Escape no lo cierra.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      return
    }
    if (e.key !== 'Tab') return
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
    if (!focusables || focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const ack = async () => {
    setSending(true)
    setError(null)
    try {
      await apiRequest(`/contingency/${contingency.id}/ack`, { method: 'POST' })
      onDone(contingency.id)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `No se pudo confirmar (${err.code}). Vuelve a intentarlo.`
          : 'Sin conexión con Lumon. Vuelve a intentarlo.',
      )
      buttonRef.current?.focus()
    } finally {
      setSending(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="contingency-title"
        aria-describedby="contingency-desc"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-lg border-2 border-rose-500 bg-slate-900 p-6 shadow-2xl"
      >
        <h2 id="contingency-title" className="text-xl font-bold text-rose-300">
          Contingencia de horas extra
        </h2>
        <p id="contingency-desc" className="mt-3 whitespace-pre-wrap text-slate-200">
          {contingency.message}
        </p>
        {error && (
          <p role="alert" className="mt-3 rounded-md bg-rose-950 p-2 text-sm text-rose-200">
            {error}
          </p>
        )}
        <button
          ref={buttonRef}
          type="button"
          onClick={() => void ack()}
          disabled={sending}
          className="mt-5 w-full rounded-md bg-rose-700 px-4 py-2 font-semibold hover:bg-rose-600 disabled:opacity-60"
        >
          {sending ? 'Confirmando…' : 'Confirmar'}
        </button>
      </div>
    </div>,
    document.body,
  )
}
