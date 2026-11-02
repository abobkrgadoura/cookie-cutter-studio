import { uid } from './constants.js'
import { DEFAULT_STROKE_MM } from './vectorEntities.js'

/**
 * The traced silhouette as editable entities.
 *
 * `rawPaths` come from the tracer in pixel space with Y up (`y = -pixelY`),
 * outer loops positive and holes negative. Editor entities live in the
 * raster frame (Y down), so each loop is mapped with a pure Y negation and no
 * resampling, no boolean, no smoothing: the vertices are the traced vertices
 * (Rule 1). Negating Y flips the signed area, so rings are reversed to keep
 * the editor convention the eraser and the CAM export already rely on:
 * outer positive, hole negative. `editorEntitiesToTraceStrokes` negates and
 * reverses again, which returns the original vertex order.
 *
 * Each outer loop becomes one `baked` region carrying the holes nested in
 * it. Every region shares `BASE_GROUP_ID`, so a silhouette made of several
 * islands is selected, moved and scaled as one body.
 */

export const BASE_GROUP_ID = 'traced-silhouette'

function signedArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function ringBounds(points) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

function pointInPolygon(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function orient(points, positive) {
  const isPositive = signedArea(points) > 0
  return isPositive === positive ? points : points.slice().reverse()
}

/**
 * Containment, not winding, decides outer versus hole, so the result does
 * not depend on which way a path was traced: a loop nested an even number of
 * times is material, odd is an opening. An island inside a hole is material
 * again and becomes its own region.
 */
export function tracePathsToBaseEntities(paths) {
  const rings = []
  for (const path of paths || []) {
    const points = []
    for (const p of path || []) {
      const x = Number(p?.x)
      const y = Number(p?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push({ x, y: -y })
    }
    if (points.length < 3) continue
    const area = Math.abs(signedArea(points))
    if (!(area > 0)) continue
    rings.push({ points, area, box: ringBounds(points) })
  }
  if (!rings.length) return []

  // Largest first, so every container of a ring precedes it in the list.
  rings.sort((a, b) => b.area - a.area)

  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]
    const sample = ring.points[0]
    let depth = 0
    let parent = -1
    for (let j = i - 1; j >= 0; j--) {
      const other = rings[j]
      const box = other.box
      if (sample.x < box.minX || sample.x > box.maxX || sample.y < box.minY || sample.y > box.maxY) continue
      if (!pointInPolygon(sample, other.points)) continue
      depth += 1
      // Descending area visits the tightest container last, so the first
      // hit scanning backwards is the immediate parent.
      if (parent < 0) parent = j
    }
    ring.depth = depth
    ring.parent = parent
  }

  const entities = []
  const regionOf = new Map()
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]
    if (ring.depth % 2 !== 0) continue
    const entity = {
      id: uid(),
      type: 'path',
      points: orient(ring.points, true),
      holes: [],
      closed: true,
      baked: true,
      base: true,
      groupId: BASE_GROUP_ID,
      strokeWidth: DEFAULT_STROKE_MM,
      lineStyle: 'filled',
    }
    regionOf.set(i, entity)
    entities.push(entity)
  }
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]
    if (ring.depth % 2 === 0) continue
    const host = regionOf.get(ring.parent)
    if (host) host.holes.push(orient(ring.points, false))
  }
  return entities
}

/**
 * True while the silhouette's geometry is still exactly what the tracer
 * produced. The cutter then keeps fitting `rawPaths` directly, byte for
 * byte as before. The first move, node drag, erase, scale or delete flips it
 * and the edited regions take over as the cavity.
 */
export function isBasePristine(current, seed) {
  if (current.length !== seed.length) return false
  for (let i = 0; i < seed.length; i++) {
    const a = current[i]
    const b = seed[i]
    if (a.id !== b.id || a.points !== b.points || a.holes !== b.holes) return false
  }
  return true
}
