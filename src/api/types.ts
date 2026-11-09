export type Permission =
  | 'files:read'
  | 'files:refine'
  | 'refiners:read'
  | 'refiners:write'
  | 'media:upload'
  | 'incidents:read'
  | 'incidents:create'
  | 'team:manage'

export interface User {
  id: number
  email: string
  displayName: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface LoginResponse extends TokenPair {
  user: User
}

export interface Me extends User {
  team: { code: string; name: string }
  role: { code: string; name: string }
  permissions: Permission[]
  clearance: { granted: boolean; grantedAt: string | null }
}
