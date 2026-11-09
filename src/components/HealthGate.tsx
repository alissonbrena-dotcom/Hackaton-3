import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { API_BASE_URL, baseHeaders } from '../api/config'

const MAX_DELAY = 30_000

/**
 * Antes de mostrar la app, comprueba GET /meta/health.
 * Si no responde: "Conectando con Lumon…" con reintento automático y espera creciente
 * (1s, 2s, 4s… hasta 30s) y un botón para reintentar a mano.
 */
export function HealthGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [nextIn, setNextIn] = useState<number | null>(null)
  const [checking, setChecking] = useState(true)
  const timer = useRef<number | null>(null)

  const check = useCallback(async () => {
    if (timer.current !== null) window.clearInterval(timer.current)
    setChecking(true)
    setNextIn(null)
    try {
      const res = await fetch(`${API_BASE_URL}/meta/health`, { headers: baseHeaders(), signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOk(true)
    } catch {
      setAttempt((a) => a + 1)
    } finally {
      setChecking(false)
    }
  }, [])

  // Primer intento
  useEffect(() => {
    void check()
  }, [check])

  // Tras cada fallo, programar el siguiente con espera creciente.
  useEffect(() => {
    if (ok || attempt === 0) return
    const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_DELAY)
    const until = Date.now() + delay
    setNextIn(Math.ceil(delay / 1000))
    timer.current = window.setInterval(() => {
      const left = until - Date.now()
      if (left <= 0) void check()
      else setNextIn(Math.ceil(left / 1000))
    }, 250)
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    }
  }, [attempt, ok, check])

  if (ok) return children
  return (
    <main className="min-h-screen grid place-items-center bg-slate-950 text-slate-100">
      <div className="text-center" role="status" aria-live="polite">
        <h1 className="text-xl font-semibold">Conectando con Lumon…</h1>
        {attempt > 0 && (
          <p className="mt-2 text-slate-300">
            {checking ? 'Reintentando…' : `Sin respuesta. Reintento ${attempt} en ${nextIn ?? 0} s.`}
          </p>
        )}
        <button type="button" onClick={() => void check()} disabled={checking} className="mt-4 rounded-md bg-sky-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-60">
          Reintentar ahora
        </button>
      </div>
    </main>
  )
}
