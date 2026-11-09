import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import type { Permission } from '../api/types'
import { ForbiddenPage } from '../pages/ForbiddenPage'
import { useAuth } from './context'

export function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center bg-slate-950 text-slate-200" role="status" aria-live="polite">
      {children}
    </div>
  )
}

/** Rutas privadas: sin sesión → /login?next=<ruta exacta con query>. */
export function RequireAuth() {
  const { state } = useAuth()
  const location = useLocation()
  if (state.status === 'checking') return <FullScreenMessage>Verificando sesión…</FullScreenMessage>
  if (state.status === 'anonymous') {
    const next = location.pathname + location.search + location.hash
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  return <Outlet />
}

/** Rutas públicas (login/registro): con sesión → a donde iba. */
export function RedirectIfAuthenticated() {
  const { state } = useAuth()
  const location = useLocation()
  if (state.status === 'checking') return <FullScreenMessage>Verificando sesión…</FullScreenMessage>
  if (state.status === 'authenticated') return <Navigate to={safeNext(location.search)} replace />
  return <Outlet />
}

/** Sin el permiso → página "sin permiso" (no un error ni pantalla en blanco). */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth()
  return can(permission) ? children : <ForbiddenPage permission={permission} />
}

/** Solo rutas internas: evita redirecciones abiertas tipo ?next=https://evil.com o //evil.com */
export function safeNext(search: string): string {
  const next = new URLSearchParams(search).get('next')
  if (next === null || !next.startsWith('/') || next.startsWith('//')) return '/files'
  return next
}
