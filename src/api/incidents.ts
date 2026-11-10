import { apiFetch } from './client'
import { getWithRetry } from './files'

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export const SEVERITIES: readonly Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
export const SEVERITY_LABEL: Record<Severity, string> = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' }

export interface Incident {
  id: number
  title: string
  description: string
  severity: Severity
  fileId: number | null
  file: { id: number; name: string } | null
  photos: { mediaId: number; url: string; width: number; height: number }[]
  createdBy: { id: number; displayName: string }
  createdAt: string
}

export interface IncidentPage {
  content: Incident[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export interface IncidentCreate {
  title: string
  description: string
  severity: Severity
  fileId: number | null
  mediaIds: number[]
}

export const getIncidents = (page: number, size: number, signal?: AbortSignal) =>
  getWithRetry<IncidentPage>(`/incidents?page=${page}&size=${size}`, signal)

/** Sin reintento automático: con caos, un 503 NO guarda nada y el usuario reintenta con el mismo formulario. */
export const createIncident = (body: IncidentCreate) => apiFetch<Incident>('/incidents', { method: 'POST', json: body })
