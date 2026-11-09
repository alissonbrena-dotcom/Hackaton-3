import { Link } from 'react-router-dom'

export function ForbiddenPage({ permission }: { permission: string }) {
  return (
    <section className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-bold">Sin permiso</h1>
      <p className="mt-2 text-slate-300">
        Tu rol no tiene el permiso <code className="rounded bg-slate-800 px-1">{permission}</code> necesario para esta sección.
      </p>
      <Link to="/" className="mt-6 inline-block text-sky-300 underline">
        Volver al inicio
      </Link>
    </section>
  )
}
