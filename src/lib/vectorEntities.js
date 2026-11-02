/**
 * Drawing entities live in the editor frame: origin at the top-left of the
 * trace raster, Y down, matching the on-screen image.
 *
 * The tracer stores the same pixels with Y flipped (`y: -pixelY`). Convert
 * only at the CAM boundary so the overlay and the silhouette share one frame.
 */

export const MIN_STROKE_MM = 0.2
export const MAX_STROKE_MM = 12
export const DEFAULT_STROKE_MM = 1.5

export const MIN_ERASER_MM = 0.2
export const MAX_ERASER_MM = 25
export const DEFAULT_ERASER_MM = 2

/** Perforation pattern applied in millimetres along a dashed centerline. */
export const DASH_CUT_MM = 5
export const DASH_GAP_MM = 2

export const VECTOR_TOOLS = [
  { id: 'select', label: 'Select' },
  { id: 'draw', label: 'Freehand' },
  { id: 'line', label: 'Line' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'circle', label: 'Circle' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'node', label: 'Node edit' },
]

const DRAW_CURSORS = new Set(['draw', 'line', 'rect', 'circle', 'eraser'])

export function vectorToolCursor(tool) {
  return DRAW_CURSORS.has(tool) ? 'crosshair' : 'default'
}

export function clampStrokeMm(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_STROKE_MM
  return Math.min(MAX_STROKE_MM, Math.max(MIN_STROKE_MM, n))
}

export function clampEraserMm(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_ERASER_MM
  return Math.min(MAX_ERASER_MM, Math.max(MIN_ERASER_MM, n))
}

export const LINE_STYLES = ['solid', 'dashed', 'filled']

export function normalizeLineStyle(value) {
  if (value === 'dashed') return 'dashed'
  if (value === 'filled') return 'filled'
  return 'solid'
}

/**
 * Entities that own an area rather than a centerline: eraser leftovers,
 * the traced silhouette (`baked`), and any closed-enough shape styled
 * `filled`. A `filled` entity needs three vertices to enclose area; a
 * two-point line has none and keeps behaving like a solid stroke.
 */
export function isFilledEntity(entity) {
  if (!entity) return false
  if (entity.baked) return true
  return entity.lineStyle === 'filled' && (entity.points?.length ?? 0) >= 3
}

/** Entities sharing a `groupId` (the traced silhouette's islands) select and move as one. */
export function entityGroupIds(entities, id) {
  const source = (entities || []).find((entity) => entity.id === id)
  if (!source) return []
  if (!source.groupId) return [source.id]
  return entities.filter((entity) => entity.groupId === source.groupId).map((entity) => entity.id)
}

/** `ids` expanded so a group is always taken whole, in entity-list order. */
export function expandSelectionIds(entities, ids) {
  const seed = new Set(ids || [])
  const picked = []
  const seen = new Set()
  for (const entity of entities || []) {
    if (!seed.has(entity.id)) continue
    for (const member of entityGroupIds(entities, entity.id)) {
      if (seen.has(member)) continue
      seen.add(member)
      picked.push(member)
    }
  }
  return picked
}

/** Whether the selection can become one group, or still has a group to break. */
export function selectionEditState(entities, ids) {
  const members = expandSelectionIds(entities, ids)
  const memberSet = new Set(members)
  let shared
  let uniform = true
  let grouped = false
  for (const entity of entities || []) {
    if (!memberSet.has(entity.id)) continue
    if (entity.groupId) grouped = true
    const key = entity.groupId || null
    if (shared === undefined) shared = key
    else if (key !== shared) uniform = false
  }
  return {
    count: members.length,
    canGroup: members.length >= 2 && !(uniform && shared),
    canUngroup: grouped,
  }
}

function entityRings(entity) {
  const rings = []
  if (entity?.points?.length) rings.push(entity.points)
  for (const hole of entity?.holes || []) {
    if (hole?.length) rings.push(hole)
  }
  return rings
}

/**
 * Axis-aligned bounds, in editor units, of every ring of the listed
 * entities (centerline geometry, not the stroke band). `null` when nothing
 * finite is selected.
 */
export function entitiesBounds(entities, ids) {
  const wanted = ids ? new Set(ids) : null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const entity of entities || []) {
    if (wanted && !wanted.has(entity.id)) continue
    for (const ring of entityRings(entity)) {
      for (const p of ring) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
    }
  }
  if (minX === Infinity) return null
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

/** An axis thinner than this has no extent to stretch (a perfectly flat line). */
const SCALE_AXIS_EPS = 1e-9

/**
 * Scales the listed entities (as one body) about the centre of their
 * combined bounding box so the box becomes `targetWidth` x `targetHeight`
 * editor units. Only vertices move; stroke widths are absolute millimetres
 * and are left alone. A non-positive or non-finite target, or a degenerate
 * axis, leaves that axis untouched. Returns the same array when nothing
 * changes so callers can bail out of a state update.
 */
export function scaleEntitiesToSize(entities, ids, targetWidth, targetHeight) {
  const bounds = entitiesBounds(entities, ids)
  if (!bounds) return entities
  const axisFactor = (target, current) => {
    if (!(target > 0) || !Number.isFinite(target) || !(current > SCALE_AXIS_EPS)) return 1
    return target / current
  }
  const fx = axisFactor(targetWidth, bounds.width)
  const fy = axisFactor(targetHeight, bounds.height)
  if (Math.abs(fx - 1) < 1e-12 && Math.abs(fy - 1) < 1e-12) return entities
  const idSet = new Set(ids)
  const scale = (ring) =>
    ring.map((p) => ({
      x: bounds.cx + (p.x - bounds.cx) * fx,
      y: bounds.cy + (p.y - bounds.cy) * fy,
    }))
  return entities.map((entity) => {
    if (!idSet.has(entity.id)) return entity
    return {
      ...entity,
      points: entity.points ? scale(entity.points) : entity.points,
      holes: entity.holes?.length ? entity.holes.map(scale) : entity.holes,
    }
  })
}

/**
 * Shifts every ring of the listed entities by (`dx`, `dy`) editor units.
 * Returns the same array when nothing moves.
 */
export function translateEntityList(entities, ids, dx, dy) {
  const count = ids instanceof Set ? ids.size : ids?.length
  if (!count) return entities
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return entities
  const idSet = ids instanceof Set ? ids : new Set(ids)
  const shift = (ring) => ring.map((p) => ({ x: p.x + dx, y: p.y + dy }))
  let changed = false
  const next = entities.map((entity) => {
    if (!idSet.has(entity.id) || !entity.points) return entity
    changed = true
    return {
      ...entity,
      points: shift(entity.points),
      holes: entity.holes?.length ? entity.holes.map(shift) : entity.holes,
    }
  })
  return changed ? next : entities
}

/**
 * `entity` with one vertex of its outline (`holeIndex` -1) or of a hole
 * placed at `point`. Returns the same entity when the vertex does not exist
 * or is already there. Untouched rings and points are shared.
 */
export function withEntityVertex(entity, index, point, holeIndex = -1) {
  const x = Number(point?.x)
  const y = Number(point?.y)
  if (!entity || !Number.isFinite(x) || !Number.isFinite(y)) return entity
  const ring = holeIndex >= 0 ? entity.holes?.[holeIndex] : entity.points
  const at = ring?.[index]
  if (!at || (at.x === x && at.y === y)) return entity
  const moved = ring.slice()
  moved[index] = { x, y }
  if (holeIndex < 0) return { ...entity, points: moved }
  const holes = entity.holes.slice()
  holes[holeIndex] = moved
  return { ...entity, holes }
}

export function editorPointToTrace(point) {
  return { x: point.x, y: -point.y }
}

/**
 * Serializable strokes in tracer pixel space (Y up), ready for the geometry
 * worker. `strokeWidth` stays in millimetres — the worker offsets after the
 * cavity fit so the width is a physical thickness, not a fraction of the image.
 */
export function editorEntitiesToTraceStrokes(entities) {
  const strokes = []
  for (const entity of entities || []) {
    const raw = entity?.points
    if (!raw || raw.length < 2) continue
    const points = []
    for (const p of raw) {
      const x = Number(p?.x)
      const y = Number(p?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push({ x, y: -y })
    }
    const strokeWidth = clampStrokeMm(entity.strokeWidth)
    if (entity.baked) {
      const rings = [raw, ...(entity.holes || [])]
      for (const ring of rings) {
        const mapped = []
        for (const p of ring) {
          const x = Number(p?.x)
          const y = Number(p?.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue
          mapped.push({ x, y: -y })
        }
        if (mapped.length < 3) continue
        // Negating Y reverses the signed area. Flip the ring back so a
        // Clipper outer stays positive in tracer space (holes stay negative).
        mapped.reverse()
        strokes.push({
          closed: true,
          baked: true,
          strokeWidth,
          lineStyle: 'solid',
          points: mapped,
        })
      }
      continue
    }
    if (points.length < 2) continue
    strokes.push({
      closed: Boolean(entity.closed),
      strokeWidth,
      lineStyle: normalizeLineStyle(entity.lineStyle),
      points,
    })
  }
  return strokes
}
