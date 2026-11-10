import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { apiRequest } from '../api/client'
import { BUILD } from '../api/config'
import { ApiError } from '../api/errors'
import { getWithRetry, isAbort } from '../api/files'

interface Check {
  name: string
  passed: boolean
  detail: string
}

interface IntegrationStatus {
  deploy: {
    origin: string | null
    verifiedAt: string | null
    lastBuildSeen: string | null
    lastBuildSeenAt: string | null
  } | null
  storage: { provider: string | null; verifiedAt: string | null; checks?: Check[] } | null
  clearance: { granted: boolean; grantedAt: string | null }
}

interface Round {
  number: number
  startsAt: string
  drawAt: string
}

interface Clearance {
  granted: boolean
  grantedAt: string | null
  checks?: Check[] | null
  checkedAt?: string | null
  workspace?: { kind: string; chaosLevel: number } | null
  round?: {
    approved: boolean
    approvedRound: number | null
    nextRound: Round | null
    drawnMember: { name: string; code: string } | null
  } | null
}

type Async<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; message: string }

const errMsg = (err: unknown) => (err instanceof ApiError ? `${err.message} (${err.code})` : 'No se pudo conectar con Lumon.')
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—')

function useLoad<T>(path: string, tick: number): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    getWithRetry<T>(path, controller.signal)
      .then((data) => setState({ status: 'ok', data }))
      .catch((err: unknown) => {
        if (!isAbort(err)) setState({ status: 'error', message: errMsg(err) })
      })
    return () => controller.abort()
  }, [path, tick])
  return state
}

function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {checks.map((c) => (
        <li key={c.name} className="flex gap-2">
          <span aria-hidden="true" className={c.passed ? 'text-emerald-400' : 'text-rose-400'}>
            {c.passed ? '✔' : '✘'}
          </span>
          <span>
            <strong>{c.name}</strong> <span className="sr-only">{c.passed ? 'aprobada' : 'pendiente'}</span>: {c.detail}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-slate-700 p-4" aria-label={title}>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  )
}

export default function EstadoPage() {
  const [tick, setTick] = useState(0)
  const [health, setHealth] = useState<Async<string>>({ status: 'loading' })
  const integrations = useLoad<IntegrationStatus>('/integrations/status', tick)
  const clearance = useLoad<Clearance>('/clearance', tick)

  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<Async<Clearance> | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    apiRequest<{ status: string }>('/meta/health', { auth: false, signal: controller.signal })
      .then(({ data }) => setHealth({ status: 'ok', data: data.status }))
      .catch((err: unknown) => {
        if (!isAbort(err)) setHealth({ status: 'error', message: errMsg(err) })
      })
    return () => controller.abort()
  }, [tick])

  const runCheck = useCallback(async () => {
    setChecking(true)
    setCheckResult({ status: 'loading' })
    try {
      const { data } = await apiRequest<Clearance>('/clearance/check', { method: 'POST' })
      setCheckResult({ status: 'ok', data })
      setTick((t) => t + 1)
    } catch (err) {
      setCheckResult({ status: 'error', message: errMsg(err) })
    } finally {
      setChecking(false)
    }
  }, [])

  const clearanceData = clearance.status === 'ok' ? clearance.data : null
  const granted = clearanceData?.granted ?? false

  return (
    <section aria-labelledby="estado-title" className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 id="estado-title" className="text-2xl font-bold">
          Estado
        </h1>
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          className="ml-auto rounded-md border border-slate-600 px-3 py-1 text-sm hover:bg-slate-800"
        >
          Actualizar
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Despliegue">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-400">Build de esta app</dt>
            <dd className="font-mono">{BUILD}</dd>
            <dt className="text-slate-400">API</dt>
            <dd role="status">
              {health.status === 'loading' && 'Comprobando…'}
              {health.status === 'ok' && <span className="text-emerald-400">Responde ({health.data})</span>}
              {health.status === 'error' && <span className="text-rose-400">Sin respuesta: {health.message}</span>}
            </dd>
          </dl>
        </Card>

        <Card title="Integraciones">
          {integrations.status === 'loading' && <p role="status">Cargando…</p>}
          {integrations.status === 'error' && <p role="alert" className="text-rose-300">{integrations.message}</p>}
          {integrations.status === 'ok' && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-slate-400">Dominio</dt>
              <dd>
                {integrations.data.deploy?.verifiedAt ? (
                  <span className="text-emerald-400">{integrations.data.deploy.origin} (verificado)</span>
                ) : (
                  <span className="text-amber-300">Sin verificar</span>
                )}
              </dd>
              <dt className="text-slate-400">Último build visto</dt>
              <dd className="font-mono">
                {integrations.data.deploy?.lastBuildSeen ?? '—'} · {fmt(integrations.data.deploy?.lastBuildSeenAt)}
              </dd>
              <dt className="text-slate-400">Storage</dt>
              <dd>
                {integrations.data.storage?.verifiedAt ? (
                  <span className="text-emerald-400">{integrations.data.storage.provider} (verificado)</span>
                ) : (
                  <span className="text-amber-300">{integrations.data.storage?.provider ?? 'Sin configurar'}</span>
                )}
              </dd>
            </dl>
          )}
        </Card>
      </div>

      <Card title="Piso de Pruebas">
        {clearance.status === 'loading' && <p role="status">Cargando…</p>}
        {clearance.status === 'error' && <p role="alert" className="text-rose-300">{clearance.message}</p>}
        {clearanceData && (
          <>
            <p className={granted ? 'text-emerald-400' : 'text-amber-300'}>
              {granted ? `Abierto desde ${fmt(clearanceData.grantedAt)}` : 'Cerrado: falta pasar la revisión automática.'}
            </p>
            {clearanceData.checks && clearanceData.checks.length > 0 && (
              <>
                <p className="mt-2 text-sm text-slate-400">Última revisión: {fmt(clearanceData.checkedAt)}</p>
                <Checks checks={clearanceData.checks} />
              </>
            )}
            {clearanceData.round && (
              <div className="mt-3 text-sm">
                <p>
                  Ronda de control:{' '}
                  {clearanceData.round.approved
                    ? `aprobada (ronda ${clearanceData.round.approvedRound ?? '—'})`
                    : clearanceData.round.nextRound
                      ? `próxima ronda ${clearanceData.round.nextRound.number}, sorteo ${fmt(clearanceData.round.nextRound.drawAt)}`
                      : 'sin rondas pendientes'}
                </p>
                {clearanceData.round.drawnMember && <p>Integrante sorteado: {clearanceData.round.drawnMember.name}</p>}
              </div>
            )}
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={checking}
            className="rounded-md bg-sky-700 px-4 py-2 font-semibold hover:bg-sky-600 disabled:opacity-60"
          >
            {checking ? 'Revisando…' : 'Abrir el Piso de Pruebas'}
          </button>
          <span className="text-xs text-slate-400">Corre la revisión automática (solo cuenta desde la app desplegada).</span>
        </div>

        <div aria-live="polite" className="mt-3">
          {checkResult?.status === 'error' && <p role="alert" className="text-rose-300">{checkResult.message}</p>}
          {checkResult?.status === 'ok' && (
            <div>
              <p className={checkResult.data.granted ? 'text-emerald-400' : 'text-amber-300'}>
                {checkResult.data.granted ? '¡Piso de Pruebas abierto!' : 'Todavía falta algo:'}
              </p>
              {checkResult.data.checks && <Checks checks={checkResult.data.checks} />}
            </div>
          )}
        </div>
      </Card>

    </section>
  )
}
