// Toda la configuración sale de variables de entorno (VITE_*) o se inyecta en el build.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
export const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL
export const BUILD = __LUMON_BUILD__

/** Cabeceras que llevan TODAS las requests de la app (incluido login y health). */
export function baseHeaders(): Headers {
  const headers = new Headers()
  headers.set('X-Lumon-Build', BUILD)
  return headers
}
