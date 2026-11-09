/** Cuerpo de error común de la API. Se decide por `error`; `message` es solo texto. */
export interface ApiErrorBody {
  error: string
  message: string
  details: unknown
  requestId?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly retryAfter: number | null

  constructor(status: number, body: ApiErrorBody, retryAfter: number | null) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.error
    this.details = body.details
    this.retryAfter = retryAfter
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return isRecord(v) && typeof v.error === 'string' && typeof v.message === 'string'
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = { error: `HTTP_${res.status}`, message: `Error ${res.status}`, details: null }
  try {
    const data: unknown = await res.json()
    if (isErrorBody(data)) body = data
  } catch {
    // El cuerpo no era JSON: nos quedamos con el genérico.
  }
  const header = res.headers.get('Retry-After')
  const retryAfter = header !== null && Number.isFinite(Number(header)) ? Number(header) : null
  return new ApiError(res.status, body, retryAfter)
}

/**
 * Convierte un error del servidor en mensajes por campo:
 * - 400 VALIDATION_ERROR → details.fields = { campo: mensaje }
 * - 409 EMAIL_TAKEN / TEAM_NAME_TAKEN → details.field = "email" | "teamName"
 */
export function fieldErrors(err: ApiError): Record<string, string> {
  const d = err.details
  if (err.code === 'VALIDATION_ERROR' && isRecord(d) && isRecord(d.fields)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(d.fields)) if (typeof v === 'string') out[k] = v
    return out
  }
  if (isRecord(d) && typeof d.field === 'string') return { [d.field]: err.message }
  return {}
}
