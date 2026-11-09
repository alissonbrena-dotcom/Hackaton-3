import { createContext, useContext } from 'react'
import type { Me, Permission } from '../api/types'
import type { EndReason } from './session'

export type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous'; reason: EndReason | null }
  | { status: 'authenticated'; me: Me }

export interface RegisterInput {
  teamName: string
  email: string
  password: string
}

export interface AuthContextValue {
  state: AuthState
  login: (email: string, password: string) => Promise<void>
  register: (input: RegisterInput) => Promise<void>
  logout: () => Promise<void>
  can: (permission: Permission) => boolean
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === null) throw new Error('useAuth debe usarse dentro de <AuthProvider>')
  return ctx
}
