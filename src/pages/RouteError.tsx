import { Link, useRouteError } from 'react-router-dom'

/** Error de render en una ruta: nunca dejamos la app en blanco. */
export default function RouteError() {
  const error = useRouteError()
  const message = error instanceof Error ? error.message : 'Error inesperado.'
  return (
    <main role="alert" className="min-h-screen grid place-items-center bg-slate-950 px-4 text-slate-100">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold">Algo falló en esta sección</h1>
        <p className="mt-2 text-slate-300">{message}</p>
        <div className="mt-6 flex justify-center gap-4">
          <Link to="/" className="text-sky-300 underline">
            Volver al inicio
          </Link>
          <button type="button" onClick={() => window.location.reload()} className="text-sky-300 underline">
            Recargar
          </button>
        </div>
      </div>
    </main>
  )
}
