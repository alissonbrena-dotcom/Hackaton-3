import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ApiError, fieldErrors } from '../api/errors'
import { useAuth } from '../auth/context'
import { Field } from '../components/Field'

type Fields = 'teamName' | 'email' | 'password'

export default function RegisterPage() {
  const { register } = useAuth()
  const location = useLocation()
  const [values, setValues] = useState<Record<Fields, string>>({ teamName: '', email: '', password: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const set = (k: Fields) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }))

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErrors({})
    setGeneral(null)
    setLoading(true)
    try {
      await register(values) // entra directo con la sesión iniciada
    } catch (err) {
      if (err instanceof ApiError) {
        const byField = fieldErrors(err)
        setErrors(byField)
        // Lo que no corresponde a un campo concreto (o "_") va como error general.
        const known = Object.keys(byField).some((k) => k === 'teamName' || k === 'email' || k === 'password')
        if (!known) setGeneral(byField._ ?? err.message)
      } else {
        setGeneral('No se pudo conectar con Lumon. Intenta de nuevo.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen grid place-items-center bg-slate-950 px-4 text-slate-100">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-700 bg-slate-900/60 p-6" noValidate>
        <h1 className="text-2xl font-bold">Registrar cuadrilla</h1>
        <Field label="Nombre de la cuadrilla" autoComplete="organization" value={values.teamName} onChange={set('teamName')} error={errors.teamName} />
        <Field label="Email" type="email" autoComplete="email" value={values.email} onChange={set('email')} error={errors.email} />
        <Field label="Contraseña (mínimo 8)" type="password" autoComplete="new-password" value={values.password} onChange={set('password')} error={errors.password} />
        {general !== null && (
          <p role="alert" className="text-sm text-red-300">
            {general}
          </p>
        )}
        <button type="submit" disabled={loading} className="w-full rounded-md bg-sky-500 px-4 py-2 font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-60">
          {loading ? 'Registrando…' : 'Registrar'}
        </button>
        <p className="text-sm text-slate-300">
          ¿Ya tienen cuenta?{' '}
          <Link to={{ pathname: '/login', search: location.search }} className="text-sky-300 underline">
            Ingresar
          </Link>
        </p>
      </form>
    </main>
  )
}
