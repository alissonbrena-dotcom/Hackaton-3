import { Link } from 'react-router-dom'

export default function NotFoundPage() {
  return (
    <main className="min-h-screen grid place-items-center bg-slate-950 text-slate-100">
      <div className="text-center">
        <p className="text-6xl font-bold text-sky-300">404</p>
        <h1 className="mt-2 text-xl">Esta sala no existe en el piso separado.</h1>
        <Link to="/" className="mt-6 inline-block text-sky-300 underline">
          Volver al inicio
        </Link>
      </div>
    </main>
  )
}
