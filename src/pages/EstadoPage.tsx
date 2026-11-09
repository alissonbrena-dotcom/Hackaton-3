import { BUILD } from '../api/config'

// TODO: estado de la API, integraciones, clearance y botón "Abrir el Piso de Pruebas" (CP3/CP6).
export default function EstadoPage() {
  return (
    <section>
      <h1 className="text-2xl font-bold">Estado</h1>
      <p className="mt-2 text-slate-300">Build desplegado: {BUILD}</p>
    </section>
  )
}
