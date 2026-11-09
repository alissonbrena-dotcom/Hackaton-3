import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiFetch } from '../api/client'
import type { LoginResponse, Me, Permission } from '../api/types'
import { AuthContext, type AuthContextValue, type AuthState, type RegisterInput } from './context'
import * as session from './session'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    session.hasStoredSession() ? { status: 'checking' } : { status: 'anonymous', reason: null },
  )

  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const loadMe = useCallback(async () => {
    const me = await apiFetch<Me>('/auth/me')
    setState({ status: 'authenticated', me })
  }, [])

  // Restaurar la sesión al recargar: refresh (si hace falta) + /auth/me.
  // Mientras tanto el estado es 'checking': no se muestra el login.
  useEffect(() => {
    if (!session.hasStoredSession()) return
    let cancelled = false
    loadMe().catch(() => {
      if (!cancelled) setState((s) => (s.status === 'checking' ? { status: 'anonymous', reason: null } : s))
    })
    return () => {
      cancelled = true
    }
  }, [loadMe])

  // Logout / revocación en esta u otra pestaña → todas vuelven al login.
  useEffect(
    () =>
      session.onSessionEnd((reason) => {
        setState({ status: 'anonymous', reason: reason === 'LOGOUT' ? null : reason })
      }),
    [],
  )

  // Si otra pestaña inicia sesión mientras esta está en el login, entramos también.
  useEffect(
    () =>
      session.onAccessFromOtherTab(() => {
        if (stateRef.current.status === 'anonymous') void loadMe().catch(() => undefined)
      }),
    [loadMe],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await apiFetch<LoginResponse>('/auth/login', { method: 'POST', json: { email, password }, auth: false })
      session.startSession(res)
      await loadMe()
    },
    [loadMe],
  )

  const register = useCallback(
    async (input: RegisterInput) => {
      const res = await apiFetch<LoginResponse>('/auth/register', { method: 'POST', json: input, auth: false })
      session.startSession(res)
      await loadMe()
    },
    [loadMe],
  )

  const logout = useCallback(() => session.logout(), [])

  const can = useCallback(
    (permission: Permission) => state.status === 'authenticated' && state.me.permissions.includes(permission),
    [state],
  )

  const value = useMemo<AuthContextValue>(
    () => ({ state, login, register, logout, can }),
    [state, login, register, logout, can],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
