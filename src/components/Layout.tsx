import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import type { Permission } from '../api/types'
import { useAuth } from '../auth/context'

const LINKS: { to: string; label: string; permission: Permission | null }[] = [
  { to: '/files', label: 'Archivos', permission: 'files:read' },
  { to: '/refiners', label: 'Personal', permission: 'refiners:read' },
  { to: '/incidents', label: 'Incidencias', permission: 'incidents:read' },
  { to: '/estado', label: 'Estado', permission: null },
]

export function Layout() {
  const { state, logout, can } = useAuth()
  const [leaving, setLeaving] = useState(false)
  const me = state.status === 'authenticated' ? state.me : null

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="font-bold tracking-wide">LUMON · MDR</span>
          <nav aria-label="Principal" className="flex gap-3">
            {LINKS.filter((l) => l.permission === null || can(l.permission)).map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'text-sky-300 underline' : 'text-slate-300 hover:text-white')}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {me !== null && (
              <span className="text-slate-300">
                {me.displayName} · {me.team.code} · {me.role.name}
              </span>
            )}
            <button
              type="button"
              disabled={leaving}
              onClick={() => {
                setLeaving(true)
                void logout().finally(() => setLeaving(false))
              }}
              className="rounded-md border border-slate-600 px-3 py-1 hover:bg-slate-800 disabled:opacity-60"
            >
              {leaving ? 'Saliendo…' : 'Cerrar sesión'}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
