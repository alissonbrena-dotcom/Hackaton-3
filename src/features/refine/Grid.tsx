import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import type { Bin, Cell, Rules } from '../../api/files'
import type { TileStore } from './tileStore'

export const CELL = 28 // px por celda
const OVERSCAN = 2
const MAX_DOM_CELLS = 2400 // el enunciado exige ≤ 2500

const BIN_BG: Record<string, string> = {
  W: 'bg-teal-800/80',
  F: 'bg-lime-800/80',
  D: 'bg-rose-900/80',
  M: 'bg-violet-900/80',
}

interface GridProps {
  store: TileStore
  rows: number
  cols: number
  rules: Rules
  selected: Set<number> | null
  /** El grupo seleccionado se puede arrastrar a una caja. */
  draggable: boolean
  initial: Cell
  onActivate: (cell: Cell) => void
  onBinKey: (index: number) => void
  onEscape: () => void
  onDrop: (bin: Bin) => void
  onPositionChange: (cell: Cell, size: { rows: number; cols: number }) => void
  /** Celdas reservadas por otros: clave r*cols+c → nombre de quien la tiene. */
  claimedBy: Map<number, string> | null
  /** Capa superpuesta (cursores de otros); debe ser un elemento estable. */
  overlay: ReactNode
  onCursor: (cell: Cell) => void
  /** Saltar a una celda (cambia `n` para repetir). */
  jumpTo: { cell: Cell; n: number } | null
}

interface Viewport {
  top: number
  left: number
  width: number
  height: number
}

function GridImpl(props: GridProps) {
  const { store, rows, cols, rules, selected, initial, claimedBy, overlay, jumpTo } = props
  useSyncExternalStore(store.subscribe, store.getVersion)

  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [vp, setVp] = useState<Viewport>({ top: initial.r * CELL, left: initial.c * CELL, width: 800, height: 600 })
  const [focus, setFocus] = useState<Cell>(initial)
  const focusFromKeyboard = useRef(false)
  const raf = useRef<number | null>(null)

  // Callbacks del padre en refs: el grid no se re-renderiza por cambios de identidad.
  const cb = useRef(props)
  cb.current = props

  // Posición inicial (?r=&c=).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = initial.r * CELL
    el.scrollLeft = initial.c * CELL
    setVp({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight })
    // Solo al montar.
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() =>
      setVp((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight })),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    if (raf.current !== null) return
    raf.current = requestAnimationFrame(() => {
      raf.current = null
      const el = scrollRef.current
      if (el) setVp({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight })
    })
  }

  // Ventana visible (+ overscan), limitada a MAX_DOM_CELLS.
  let r0 = Math.max(0, Math.floor(vp.top / CELL) - OVERSCAN)
  let r1 = Math.min(rows - 1, Math.ceil((vp.top + vp.height) / CELL) + OVERSCAN)
  const c0 = Math.max(0, Math.floor(vp.left / CELL) - OVERSCAN)
  const c1 = Math.min(cols - 1, Math.ceil((vp.left + vp.width) / CELL) + OVERSCAN)
  const width = c1 - c0 + 1
  if ((r1 - r0 + 1) * width > MAX_DOM_CELLS) {
    r0 = Math.max(0, Math.floor(vp.top / CELL))
    r1 = Math.min(r1, r0 + Math.floor(MAX_DOM_CELLS / width) - 1)
  }

  // Pide solo los bloques de la ventana; cancela los que salieron.
  const ts = store.tileSize
  const tr0 = Math.floor(r0 / ts)
  const tr1 = Math.floor(r1 / ts)
  const tc0 = Math.floor(c0 / ts)
  const tc1 = Math.floor(c1 / ts)
  useEffect(() => {
    const keys: { tr: number; tc: number }[] = []
    for (let tr = tr0; tr <= tr1; tr++) for (let tc = tc0; tc <= tc1; tc++) keys.push({ tr, tc })
    store.setVisible(keys)
  }, [store, tr0, tr1, tc0, tc1])

  // La URL indica la posición (sin llenar el historial: replace + debounce).
  const posR = Math.floor(vp.top / CELL)
  const posC = Math.floor(vp.left / CELL)
  const viewRows = Math.max(1, Math.floor(vp.height / CELL))
  const viewCols = Math.max(1, Math.floor(vp.width / CELL))
  useEffect(() => {
    const t = window.setTimeout(() => cb.current.onPositionChange({ r: posR, c: posC }, { rows: viewRows, cols: viewCols }), 300)
    return () => window.clearTimeout(t)
  }, [posR, posC, viewRows, viewCols])

  // Lleva el foco del DOM a la celda activa después de moverla con el teclado.
  useEffect(() => {
    if (!focusFromKeyboard.current) return
    focusFromKeyboard.current = false
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-r="${focus.r}"][data-c="${focus.c}"]`)
    el?.focus({ preventScroll: true })
  }, [focus])

  const scrollIntoView = useCallback((cell: Cell) => {
    const el = scrollRef.current
    if (!el) return
    const top = cell.r * CELL
    const left = cell.c * CELL
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + CELL > el.scrollTop + el.clientHeight) el.scrollTop = top + CELL - el.clientHeight
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (left + CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = left + CELL - el.clientWidth
  }, [])

  const moveFocus = (cell: Cell) => {
    const next = { r: Math.min(rows - 1, Math.max(0, cell.r)), c: Math.min(cols - 1, Math.max(0, cell.c)) }
    focusFromKeyboard.current = true
    setFocus(next)
    scrollIntoView(next)
    cb.current.onCursor(next)
  }

  // Ir a la posición de otro refinador: centra la celda y le pasa el foco.
  useEffect(() => {
    const el = scrollRef.current
    if (!jumpTo || !el) return
    el.scrollTop = Math.max(0, jumpTo.cell.r * CELL - el.clientHeight / 2)
    el.scrollLeft = Math.max(0, jumpTo.cell.c * CELL - el.clientWidth / 2)
    focusFromKeyboard.current = true
    setFocus(jumpTo.cell)
  }, [jumpTo])

  const onKeyDown = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(vp.height / CELL) - 1)
    switch (e.key) {
      case 'ArrowUp':
        moveFocus({ r: focus.r - 1, c: focus.c })
        break
      case 'ArrowDown':
        moveFocus({ r: focus.r + 1, c: focus.c })
        break
      case 'ArrowLeft':
        moveFocus({ r: focus.r, c: focus.c - 1 })
        break
      case 'ArrowRight':
        moveFocus({ r: focus.r, c: focus.c + 1 })
        break
      case 'PageUp':
        moveFocus({ r: focus.r - page, c: focus.c })
        break
      case 'PageDown':
        moveFocus({ r: focus.r + page, c: focus.c })
        break
      case 'Home':
        moveFocus(e.ctrlKey ? { r: 0, c: 0 } : { r: focus.r, c: 0 })
        break
      case 'End':
        moveFocus(e.ctrlKey ? { r: rows - 1, c: cols - 1 } : { r: focus.r, c: cols - 1 })
        break
      case 'Enter':
      case ' ':
        cb.current.onActivate(focus)
        break
      case 'Escape':
        cb.current.onEscape()
        break
      case '1':
      case '2':
      case '3':
      case '4':
        cb.current.onBinKey(Number(e.key) - 1)
        break
      default:
        return
    }
    e.preventDefault()
  }

  // ---- Arrastre con Pointer Events (sin librería) ----
  const drag = useRef<{ x: number; y: number; active: boolean; over: HTMLElement | null } | null>(null)
  const suppressClick = useRef(false)

  const binUnder = (x: number, y: number): HTMLElement | null => {
    const ghost = ghostRef.current
    if (ghost) ghost.style.display = 'none'
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-bin]') ?? null
    if (ghost && drag.current?.active) ghost.style.display = 'block'
    return el
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !cb.current.draggable || !selected) return
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')
    if (!target) return
    const k = Number(target.dataset.r) * cols + Number(target.dataset.c)
    if (!selected.has(k)) return
    drag.current = { x: e.clientX, y: e.clientY, active: false, over: null }
    gridRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')
      if (target) cb.current.onCursor({ r: Number(target.dataset.r), c: Number(target.dataset.c) })
      return
    }
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      d.active = true
      if (ghostRef.current) ghostRef.current.style.display = 'block'
    }
    if (!d.active) return
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`
    const over = binUnder(e.clientX, e.clientY)
    if (over !== d.over) {
      d.over?.removeAttribute('data-drop-target')
      over?.setAttribute('data-drop-target', 'true')
      d.over = over
    }
  }

  const endDrag = (e: PointerEvent, cancelled: boolean) => {
    const d = drag.current
    drag.current = null
    if (ghostRef.current) ghostRef.current.style.display = 'none'
    if (gridRef.current?.hasPointerCapture(e.pointerId)) gridRef.current.releasePointerCapture(e.pointerId)
    if (!d?.active) return
    d.over?.removeAttribute('data-drop-target')
    suppressClick.current = true
    const bin = d.over?.dataset.bin
    if (!cancelled && (bin === 'WO' || bin === 'FC' || bin === 'DR' || bin === 'MA')) cb.current.onDrop(bin)
  }

  const onClick = (e: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')
    if (!target) return
    const cell = { r: Number(target.dataset.r), c: Number(target.dataset.c) }
    setFocus(cell)
    cb.current.onActivate(cell)
  }

  // ---- Render ----
  const renderCell = (r: number, c: number): ReactNode => {
    const hit = store.cellAt(r, c)
    const isFocus = r === focus.r && c === focus.c
    const style: CSSProperties & Record<string, string | number> = {
      position: 'absolute',
      left: c * CELL,
      width: CELL,
      height: CELL,
    }
    if (!hit) {
      return (
        <div
          key={c}
          role="gridcell"
          aria-colindex={c + 1}
          aria-label="Cargando"
          data-r={r}
          data-c={c}
          tabIndex={isFocus ? 0 : -1}
          style={style}
          className="border border-slate-900 bg-slate-800/60 outline-none focus:ring-2 focus:ring-sky-400"
        />
      )
    }
    const { tile, i } = hit
    const tremor = tile.tremor[i]
    const scary = tremor >= rules.tremorThreshold
    const bin = tile.bins[i]
    const refined = bin !== '.'
    const isSel = selected?.has(r * cols + c) ?? false
    const holder = claimedBy?.get(r * cols + c)
    if (scary && !refined) {
      style['--amp'] = `${(0.4 + (tremor / 100) * 1.4).toFixed(2)}px`
      style['--dur'] = `${Math.round(520 - tremor * 3)}ms`
      style.animationDelay = `${-((r * 37 + c * 17) % 400)}ms`
    }
    const label = `${tile.values[i]}${scary ? ', da miedo' : ''}${refined ? `, en caja ${bin}` : ''}${isSel ? ', seleccionada' : ''}${holder ? `, reservada por ${holder}` : ''}`
    return (
      <div
        key={c}
        role="gridcell"
        aria-colindex={c + 1}
        aria-selected={isSel}
        aria-label={label}
        data-r={r}
        data-c={c}
        title={holder ? `Reservada por ${holder}` : undefined}
        tabIndex={isFocus ? 0 : -1}
        style={style}
        className={[
          'grid select-none place-items-center font-mono text-sm outline-none focus:ring-2 focus:ring-sky-400',
          refined ? BIN_BG[bin] ?? '' : '',
          isSel ? 'bg-sky-700 ring-1 ring-sky-300' : '',
          holder && !isSel ? 'bg-orange-950 outline outline-1 outline-dashed outline-orange-400' : '',
          scary && !refined ? 'mdr-scary cursor-pointer' : 'text-slate-400',
        ].join(' ')}
      >
        <span aria-hidden="true">{tile.values[i]}</span>
      </div>
    )
  }

  const rowEls: ReactNode[] = []
  const focusInWindow = focus.r >= r0 && focus.r <= r1 && focus.c >= c0 && focus.c <= c1
  for (let r = r0; r <= r1; r++) {
    const cells: ReactNode[] = []
    for (let c = c0; c <= c1; c++) cells.push(renderCell(r, c))
    if (!focusInWindow && r === focus.r) cells.push(renderCell(focus.r, focus.c))
    rowEls.push(
      <div key={r} role="row" aria-rowindex={r + 1} style={{ position: 'absolute', top: r * CELL, height: CELL, left: 0, right: 0 }}>
        {cells}
      </div>,
    )
  }
  // La celda con foco siempre está en el DOM, aunque esté fuera de la ventana.
  if (!focusInWindow && (focus.r < r0 || focus.r > r1)) {
    rowEls.push(
      <div key={`f${focus.r}`} role="row" aria-rowindex={focus.r + 1} style={{ position: 'absolute', top: focus.r * CELL, height: CELL, left: 0, right: 0 }}>
        {renderCell(focus.r, focus.c)}
      </div>,
    )
  }

  return (
    <>
      <div ref={scrollRef} onScroll={onScroll} className="relative h-[65vh] overflow-auto rounded-md border border-slate-700 bg-slate-950">
        <div
          ref={gridRef}
          role="grid"
          aria-label="Grilla del archivo"
          aria-rowcount={rows}
          aria-colcount={cols}
          aria-multiselectable="true"
          onKeyDown={onKeyDown}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
          style={{ position: 'relative', width: cols * CELL, height: rows * CELL }}
        >
          {rowEls}
          {overlay}
        </div>
      </div>
      <div
        ref={ghostRef}
        aria-hidden="true"
        style={{ display: 'none', position: 'fixed', top: 0, left: 0, pointerEvents: 'none', zIndex: 50 }}
        className="rounded-md bg-sky-600 px-2 py-1 text-sm font-semibold shadow-lg"
      >
        Grupo · {selected?.size ?? 0} celdas
      </div>
    </>
  )
}

export const Grid = memo(GridImpl)
