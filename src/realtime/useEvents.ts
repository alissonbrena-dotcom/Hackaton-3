import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getStatus, onStatus, subscribe, type LumonEvent } from './events'

/**
 * Suscribe un handler a un tipo de evento ('*' para todos). El handler puede cambiar entre renders
 * sin volver a suscribirse.
 */
export function useLumonEvent(type: string, handler: (e: LumonEvent) => void) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => subscribe(type, (e) => ref.current(e)), [type])
}

export function useStreamStatus() {
  return useSyncExternalStore(onStatus, getStatus)
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
