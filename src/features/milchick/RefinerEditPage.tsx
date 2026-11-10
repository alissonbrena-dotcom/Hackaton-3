import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiRequest } from '../../api/client'
import { ApiError, fieldErrors } from '../../api/errors'
import { getWithRetry, isAbort } from '../../api/files'
import { isRecord, useLumonEvent } from '../../realtime/useEvents'

/**
 * /refiners/:id/edit — Regla de Milchick: nunca se sobrescribe lo que no se ha leído.
 * - PATCH siempre con If-Match = ETag leído (nunca "*").
 * - Si llega refiner.updated de este expediente mientras se edita, se avisa antes de guardar.
 * - Ante 412, pantalla de conflicto campo por campo; se elige y se reintenta con el ETag nuevo.
 * - Una versión más vieja nunca pisa a una más nueva (por stream o por HTTP).
 */

interface Department {
  id: number
  code: string
  name: string
}

interface Refiner {
  id: number
  fullName: string
  department: Department
  title: string
  extension: string
  bio: string
  version: number
}

type Field = 'title' | 'extension' | 'bio' | 'departmentId'

interface Draft {
  title: string
  extension: string
  bio: string
  departmentId: number
}

const FIELDS: { key: Field; label: string }[] = [
  { key: 'title', label: 'Título' },
  { key: 'extension', label: 'Anexo' },
  { key: 'departmentId', label: 'Departamento' },
  { key: 'bio', label: 'Biografía' },
]

const toDraft = (r: Refiner): Draft => ({
  title: r.title,
  extension: r.extension,
  bio: r.bio,
  departmentId: r.department.id,
})

const etagOf = (r: Refiner) => `"${r.version}"`

function asRefiner(v: unknown): Refiner | null {
  if (!isRecord(v) || typeof v.id !== 'number' || typeof v.version !== 'number' || !isRecord(v.department)) return null
  return v as unknown as Refiner
}

type Conflict = { server: Refiner; choice: Record<Field, 'mine' | 'server'> }

export default function RefinerEditPage() {
  const { id: idParam } = useParams()
  const id = Number(idParam)
  const [base, setBase] = useState<Refiner | null>(null) // lo que leímos (y su ETag)
  const [etag, setEtag] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [remote, setRemote] = useState<{ refiner: Refiner; by: string } | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const baseRef = useRef<Refiner | null>(null)
  baseRef.current = base

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) {
      setLoadError('Identificador de expediente inválido.')
      return
    }
    const ctl = new AbortController()
    setLoadError(null)
    Promise.all([
      apiRequest<Refiner>(`/refiners/${id}`, { signal: ctl.signal }),
      getWithRetry<Department[]>('/departments', ctl.signal),
    ])
      .then(([res, deps]) => {
        setBase(res.data)
        setEtag(res.headers.get('ETag') ?? etagOf(res.data))
        setDraft(toDraft(res.data))
        setDepartments(Array.isArray(deps) ? deps : [])
        setRemote(null)
        setConflict(null)
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? 'Ese expediente no existe.'
            : err instanceof ApiError
              ? err.message
              : 'No se pudo conectar con Lumon.',
        )
      })
    return () => ctl.abort()
  }, [id, reload])

  // Alguien cambió el expediente mientras editamos: se avisa antes de guardar (solo si es más nuevo).
  useLumonEvent('refiner.updated', (e) => {
    const d = e.data
    if (!isRecord(d) || d.id !== id) return
    const refiner = asRefiner(d.refiner)
    const current = baseRef.current
    if (!refiner || !current || refiner.version <= current.version) return
    const by = isRecord(d.updatedBy) && typeof d.updatedBy.displayName === 'string' ? d.updatedBy.displayName : 'alguien'
    setRemote((prev) => (prev && prev.refiner.version >= refiner.version ? prev : { refiner, by }))
  })

  const changedFields = useCallback(
    (from: Refiner, to: Draft): Partial<Draft> => {
      const out: Partial<Draft> = {}
      if (to.title !== from.title) out.title = to.title
      if (to.extension !== from.extension) out.extension = to.extension
      if (to.bio !== from.bio) out.bio = to.bio
      if (to.departmentId !== from.department.id) out.departmentId = to.departmentId
      return out
    },
    [],
  )

  const openConflict = (server: Refiner) => {
    if (!draft) return
    const choice = {} as Record<Field, 'mine' | 'server'>
    for (const f of FIELDS) choice[f.key] = 'mine'
    setConflict({ server, choice })
  }

  const patch = async (from: Refiner, ifMatch: string, values: Draft) => {
    const body = changedFields(from, values)
    if (Object.keys(body).length === 0) {
      setStatus({ kind: 'ok', text: 'No hay cambios que guardar.' })
      return
    }
    setSaving(true)
    setErrors({})
    setStatus(null)
    try {
      const res = await apiRequest<Refiner>(`/refiners/${id}`, {
        method: 'PATCH',
        headers: { 'If-Match': ifMatch },
        json: body,
      })
      // Una respuesta vieja nunca pisa una versión más nueva ya conocida.
      if (!baseRef.current || res.data.version >= baseRef.current.version) {
        setBase(res.data)
        setEtag(res.headers.get('ETag') ?? etagOf(res.data))
        setDraft(toDraft(res.data))
      }
      setRemote(null)
      setConflict(null)
      setStatus({ kind: 'ok', text: `Guardado (versión ${res.data.version}).` })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        const server = isRecord(err.details) ? asRefiner(err.details.current) : null
        if (server) openConflict(server)
        else setStatus({ kind: 'error', text: 'El expediente cambió. Recarga para ver la versión actual.' })
      } else if (err instanceof ApiError) {
        setErrors(fieldErrors(err))
        setStatus({ kind: 'error', text: err.message })
      } else {
        setStatus({ kind: 'error', text: 'Sin conexión con Lumon. Tus cambios siguen en el formulario.' })
      }
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!base || !etag || !draft) return
    // Si ya sabemos que hay una versión más nueva, se muestra el conflicto antes de guardar.
    if (remote) {
      openConflict(remote.refiner)
      return
    }
    void patch(base, etag, draft)
  }

  const resolveConflict = () => {
    if (!conflict || !draft) return
    const s = conflict.server
    const merged: Draft = {
      title: conflict.choice.title === 'mine' ? draft.title : s.title,
      extension: conflict.choice.extension === 'mine' ? draft.extension : s.extension,
      bio: conflict.choice.bio === 'mine' ? draft.bio : s.bio,
      departmentId: conflict.choice.departmentId === 'mine' ? draft.departmentId : s.department.id,
    }
    setBase(s)
    setEtag(etagOf(s))
    setDraft(merged)
    setRemote(null)
    void patch(s, etagOf(s), merged)
  }

  const depName = (depId: number) => departments.find((d) => d.id === depId)?.name ?? `#${depId}`
  const show = (f: Field, v: Draft | Refiner): string => {
    if (f === 'departmentId') return depName('department' in v ? v.department.id : v.departmentId)
    return v[f]
  }

  if (loadError) {
    return (
      <div role="alert" className="space-y-3">
        <p>{loadError}</p>
        <button type="button" onClick={() => setReload((n) => n + 1)} className="rounded-md bg-sky-700 px-3 py-1 hover:bg-sky-600">
          Reintentar
        </button>
        <Link to="/refiners" className="block text-sky-300 underline">
          Volver al directorio
        </Link>
      </div>
    )
  }
  if (!base || !draft) return <p role="status">Cargando expediente…</p>

  if (conflict) {
    return (
      <section aria-labelledby="conflict-title" className="max-w-3xl space-y-4">
        <h1 id="conflict-title" className="text-2xl font-bold">
          Conflicto de versiones
        </h1>
        <p role="alert" className="rounded-md bg-amber-950 p-3 text-amber-200">
          El expediente de {conflict.server.fullName} cambió (ahora es la versión {conflict.server.version}). Elige, campo por campo,
          qué valor conservar. Nada se guarda hasta que confirmes.
        </p>
        <table className="w-full text-left text-sm">
          <thead className="text-slate-300">
            <tr>
              <th scope="col" className="py-2">Campo</th>
              <th scope="col">Lo que escribiste</th>
              <th scope="col">Lo que hay en el servidor</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map(({ key, label }) => {
              const mine = show(key, draft)
              const theirs = show(key, conflict.server)
              const same = mine === theirs
              return (
                <tr key={key} className={`border-t border-slate-800 align-top ${same ? 'text-slate-500' : ''}`}>
                  <th scope="row" className="py-2 pr-2">{label}</th>
                  {(['mine', 'server'] as const).map((side) => (
                    <td key={side} className="py-2 pr-2">
                      <label className="flex gap-2">
                        <input
                          type="radio"
                          name={`choice-${key}`}
                          checked={conflict.choice[key] === side}
                          disabled={same}
                          onChange={() => setConflict({ ...conflict, choice: { ...conflict.choice, [key]: side } })}
                        />
                        <span className="whitespace-pre-wrap break-words">{side === 'mine' ? mine : theirs}</span>
                      </label>
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={resolveConflict}
            className="rounded-md bg-sky-700 px-4 py-2 font-semibold hover:bg-sky-600 disabled:opacity-60"
          >
            {saving ? 'Guardando…' : 'Guardar con la versión nueva'}
          </button>
          <button
            type="button"
            onClick={() => {
              setBase(conflict.server)
              setEtag(etagOf(conflict.server))
              setDraft(toDraft(conflict.server))
              setConflict(null)
              setRemote(null)
            }}
            className="rounded-md border border-slate-600 px-4 py-2 hover:bg-slate-800"
          >
            Descartar mis cambios
          </button>
        </div>
      </section>
    )
  }

  return (
    <section aria-labelledby="edit-title" className="max-w-2xl space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 id="edit-title" className="text-2xl font-bold">
          Editar a {base.fullName}
        </h1>
        <span className="text-sm text-slate-400">versión {base.version}</span>
        <Link to="/refiners" className="ml-auto text-sm text-sky-300 underline">
          Volver al directorio
        </Link>
      </div>

      {remote && (
        <div role="alert" className="rounded-md border border-amber-600 bg-amber-950 p-3 text-amber-200">
          {remote.by} cambió este expediente (versión {remote.refiner.version}) mientras lo editabas. Al guardar vas a poder comparar
          campo por campo.
          <button type="button" onClick={() => openConflict(remote.refiner)} className="ml-2 underline">
            Comparar ahora
          </button>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <label className="block">
          <span className="text-sm">Título</span>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            maxLength={200}
            required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? 'err-title' : undefined}
            className="mt-1 w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          />
          {errors.title && <span id="err-title" className="text-sm text-rose-300">{errors.title}</span>}
        </label>
        <label className="block">
          <span className="text-sm">Anexo (3 a 6 dígitos)</span>
          <input
            value={draft.extension}
            onChange={(e) => setDraft({ ...draft, extension: e.target.value })}
            inputMode="numeric"
            pattern="[0-9]{3,6}"
            aria-invalid={errors.extension ? true : undefined}
            aria-describedby={errors.extension ? 'err-extension' : undefined}
            className="mt-1 w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          />
          {errors.extension && <span id="err-extension" className="text-sm text-rose-300">{errors.extension}</span>}
        </label>
        <label className="block">
          <span className="text-sm">Departamento</span>
          <select
            value={draft.departmentId}
            onChange={(e) => setDraft({ ...draft, departmentId: Number(e.target.value) })}
            className="mt-1 w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          >
            {departments.length === 0 && <option value={draft.departmentId}>{base.department.name}</option>}
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          {errors.departmentId && <span className="text-sm text-rose-300">{errors.departmentId}</span>}
        </label>
        <label className="block">
          <span className="text-sm">Biografía</span>
          <textarea
            value={draft.bio}
            onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
            maxLength={2000}
            rows={5}
            aria-invalid={errors.bio ? true : undefined}
            className="mt-1 w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5"
          />
          {errors.bio && <span className="text-sm text-rose-300">{errors.bio}</span>}
        </label>
        {status && (
          <p role={status.kind === 'error' ? 'alert' : 'status'} className={status.kind === 'error' ? 'text-rose-300' : 'text-emerald-300'}>
            {status.text}
          </p>
        )}
        <button type="submit" disabled={saving} className="rounded-md bg-sky-700 px-4 py-2 font-semibold hover:bg-sky-600 disabled:opacity-60">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </form>
    </section>
  )
}
