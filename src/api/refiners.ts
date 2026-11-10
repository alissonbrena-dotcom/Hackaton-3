import { apiRequest } from './client'
import { getWithRetry } from './files'

// Tipos según Swagger. Los textos (fullName, title, bio…) vienen DEL EXTERIOR:
// se muestran siempre como texto en JSX, nunca con dangerouslySetInnerHTML.

export interface Department {
  id: number
  code: string
  name: string
}

export interface Badge {
  url: string
  width: number
  height: number
}

export interface Refiner {
  id: number
  fullName: string
  department: Department
  title: string
  extension: string
  bio: string
  profileUrl: string | null
  badge: Badge | null
  version: number
  updatedAt: string
}

export interface RefinerPage {
  content: Refiner[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export interface RefinerPatch {
  title?: string
  extension?: string
  bio?: string
  departmentId?: number
  badgeMediaId?: number | null
}

export const getDepartments = (signal?: AbortSignal) => getWithRetry<Department[]>('/departments', signal)

export const getRefiners = (params: URLSearchParams, signal?: AbortSignal) =>
  getWithRetry<RefinerPage>(`/refiners?${params.toString()}`, signal)

/** GET de un expediente + su ETag (lo necesita el PATCH: Regla de Milchick). */
export async function getRefiner(id: number, signal?: AbortSignal): Promise<{ refiner: Refiner; etag: string }> {
  const { data, headers } = await apiRequest<Refiner>(`/refiners/${id}`, { signal })
  return { refiner: data, etag: headers.get('ETag') ?? `"${data.version}"` }
}

/** PATCH con If-Match = el ETag exacto que leímos. Nunca `*`. */
export async function patchRefiner(id: number, etag: string, patch: RefinerPatch): Promise<{ refiner: Refiner; etag: string }> {
  const { data, headers } = await apiRequest<Refiner>(`/refiners/${id}`, {
    method: 'PATCH',
    headers: { 'If-Match': etag },
    json: patch,
  })
  return { refiner: data, etag: headers.get('ETag') ?? `"${data.version}"` }
}

/** Solo enlazamos URLs http(s): un `javascript:` en un href ejecutaría código (XSS). */
export function safeHttpUrl(url: string | null): string | null {
  if (url === null) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
