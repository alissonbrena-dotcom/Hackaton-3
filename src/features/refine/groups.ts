import type { Bin, Cell, Rules } from '../../api/files'
import type { TileStore } from './tileStore'

export interface Group {
  cells: Cell[]
  /** Claves r*cols+c, para pintar la selección en O(1). */
  keys: Set<number>
  size: number
  /** Caja que corresponde según las reglas, o null si es ruido. */
  bin: Bin | null
  noise: boolean
  /** true si el grupo es más grande que maxGroupSize (dejamos de explorar). */
  truncated: boolean
  /** Caja en la que ya está, si estaba refinado. */
  refinedAs: string | null
}

const N4 = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const
const N8 = [...N4, [-1, -1], [-1, 1], [1, -1], [1, 1]] as const

export function binFor(digits: number[], rules: Rules): Bin {
  const index =
    rules.binning.strategy === 'DIGIT_SUM_MOD'
      ? digits.reduce((a, d) => a + d, 0) % 4
      : Math.max(...digits) % 4
  return rules.binning.order[index]
}

export const isScary = (tremor: number, rules: Rules) => tremor >= rules.tremorThreshold

/**
 * Busca el grupo completo (componente conexo máximo de celdas que dan miedo) que contiene (r, c).
 * Si cruza bloques que no están cargados, los pide al store. Devuelve null si la celda no da miedo.
 */
export async function findGroup(
  store: TileStore,
  rules: Rules,
  rows: number,
  cols: number,
  start: Cell,
  signal: AbortSignal,
): Promise<Group | null> {
  const ts = store.tileSize
  const get = async (r: number, c: number) => {
    let hit = store.cellAt(r, c)
    if (!hit) {
      await store.ensure(Math.floor(r / ts), Math.floor(c / ts))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      hit = store.cellAt(r, c)
    }
    if (!hit) throw new Error('No se pudo cargar el bloque')
    return { tremor: hit.tile.tremor[hit.i], value: hit.tile.values[hit.i], bin: hit.tile.bins[hit.i] }
  }

  const first = await get(start.r, start.c)
  if (!isScary(first.tremor, rules)) return null

  const neighbors = rules.connectivity === 8 ? N8 : N4
  const keys = new Set<number>([start.r * cols + start.c])
  const cells: Cell[] = [start]
  const digits: number[] = [first.value]
  const queue: Cell[] = [start]
  // Un grupo más grande que maxGroupSize es ruido: no hace falta conocerlo entero.
  const limit = rules.maxGroupSize + 1
  let truncated = false

  while (queue.length > 0) {
    const cur = queue.shift() as Cell
    for (const [dr, dc] of neighbors) {
      const r = cur.r + dr
      const c = cur.c + dc
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue
      const k = r * cols + c
      if (keys.has(k)) continue
      const cell = await get(r, c)
      if (!isScary(cell.tremor, rules)) continue
      keys.add(k)
      cells.push({ r, c })
      digits.push(cell.value)
      queue.push({ r, c })
      if (cells.length >= limit) {
        truncated = true
        queue.length = 0
        break
      }
    }
  }

  const size = cells.length
  const noise = truncated || size < rules.minGroupSize || size > rules.maxGroupSize
  return {
    cells,
    keys,
    size,
    noise,
    truncated,
    bin: noise ? null : binFor(digits, rules),
    refinedAs: first.bin === '.' ? null : first.bin,
  }
}
