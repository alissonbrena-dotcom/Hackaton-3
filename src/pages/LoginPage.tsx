import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ApiError } from '../api/errors'
import { useAuth } from '../auth/context'
import type { EndReason } from '../auth/session'
import { Field } from '../components/Field'

const REASON_TEXT: Record<Exclude<EndReason, 'LOGOUT'>, string> = {
  REFRESH_REUSED: 'Se detectó un uso repetido de tu sesión y Lumon la cerró por seguridad. Inicia sesión de nuevo.',
  SESSION_REVOKED: 'Tu sesión fue revocada. Inicia sesión de nuevo.',
  TOKEN_INVALID: 'Tu sesión dejó de ser válida. Inicia sesión de nuevo.',
  REFRESH_INVALID: 'Tu sesión expiró. Inicia sesión de nuevo.',
}

export default function LoginPage() {
  const { state, login } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reason = state.status === 'anonymous' && state.reason !== null && state.reason !== 'LOGOUT' ? state.reason : null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
      // La redirección a ?next la hace <RedirectIfAuthenticated> al cambiar el estado.
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') setError('Email o contraseña incorrectos.')
      else if (err instanceof ApiError) setError(err.message)
      else setError('No se pudo conectar con Lumon. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen grid place-items-center bg-slate-950 px-4 text-slate-100">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-700 bg-slate-900/60 p-6" noValidate>
        <h1 className="text-2xl font-bold">Ingreso al piso</h1>
        {reason !== null && (
          <p role="alert" className="rounded-md border border-amber-400/50 bg-amber-950/60 p-3 text-sm text-amber-100">
            {REASON_TEXT[reason]}
          </p>
        )}
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Contraseña" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error !== null && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        <button type="submit" disabled={loading} className="w-full rounded-md bg-sky-500 px-4 py-2 font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-60">
          {loading ? 'Ingresando…' : 'Ingresar'}
        </button>
        <p className="text-sm text-slate-300">
          ¿Cuadrilla nueva?{' '}
          <Link to={{ pathname: '/register', search: location.search }} className="text-sky-300 underline">
            Registrarla
          </Link>
        </p>
      </form>
    </main>
  )
}
