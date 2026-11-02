import { uid } from './constants.js'
import { booleanDifference } from './clipperWrapper.js'
import { isFilledEntity } from './vectorEntities.js'
import { circlePoints } from './vectorPrimitives.js'
import { expandStrokeToPolygons } from './vectorStroke.js'

const ERASER_SEGMENTS = 32
/** Area change below this (editor units²) is Clipper snap noise, not a cut. */
const AREA_EPS = 0.25

function signedArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function absArea(points) {
  return Math.abs(signedArea(points))
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

function centroid(points) {
  let x = 0
  let y = 0
  for (const p of points) {
    x += p.x
    y += p.y
  }
  const n = points.length || 1
  return { x: x / n, y: y / n }
}

/**
 * Clipper2 returns a difference as separate rings: positive area is material,
 * negative area is a hole. Disconnected leftovers become separate entities.
 * Each hole stays on the smallest outer that contains it so the fill and the
 * CAM union keep the opening.
 */
function groupRings(loops) {
  const positive = []
  const negative = []
  for (const loop of loops) {
    if (signedArea(loop) < 0) negative.push(loop)
    else positive.push(loop)
  }
  let outers = positive
  let holes = negative
  if (!outers.length && holes.length) {
    holes = [...holes].sort((a, b) => absArea(b) - absArea(a))
    outers = [[...holes[0]].reverse()]
    holes = holes.slice(1)
  }
  const groups = outers.map((outer) => ({ outer, holes: [] }))
  for (const hole of holes) {
    const sample = centroid(hole)
    let host = null
    let hostArea = Infinity
    for (const group of groups) {
      if (!pointInPolygon(sample, group.outer)) continue
      const area = absArea(group.outer)
      if (area < hostArea) {
        hostArea = area
        host = group
      }
    }
    if (host) host.holes.push(hole)
  }
  groups.sort((a, b) => absArea(b.outer) - absArea(a.outer))
  return groups
}

function totalArea(loops) {
  let sum = 0
  for (const loop of loops) sum += absArea(loop)
  return sum
}

function missesDisk(points, center, reach) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const x = Math.min(maxX, Math.max(minX, center.x))
  const y = Math.min(maxY, Math.max(minY, center.y))
  return Math.hypot(center.x - x, center.y - y) > reach
}

/**
 * Subtracts one eraser disk from every stroke it touches.
 *
 * Centerlines are inflated to their stroke band first (the same Minkowski
 * offset CAM uses, evaluated in editor pixels), then Clipper2
 * `booleanDifference` removes the disk. A hit replaces the centerline with
 * the remaining filled loops (`baked`), so the 3D pass does not offset
 * them a second time. A miss returns the original entity so node editing
 * and stroke width stay on the centerline.
 */
export function eraseEntities(entities, center, radiusUnits, pixelsPerMm) {
  if (!entities?.length) return entities || []
  const radius = Number(radiusUnits)
  const scale = Number(pixelsPerMm)
  if (!(radius > 0) || !(scale > 0)) return entities
  if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y)) return entities

  const eraser = circlePoints(center, radius, ERASER_SEGMENTS)
  if (eraser.length < 3) return entities

  let changed = false
  const next = []
  for (const entity of entities) {
    const pts = entity?.points
    if (!pts || pts.length < 2) {
      next.push(entity)
      continue
    }
    // A filled entity owns its area, so the disk bites the outline itself.
    // Only a centerline stroke has a band to inflate.
    const filled = isFilledEntity(entity)
    const halfStroke = filled ? 0 : ((Number(entity.strokeWidth) || 0) * scale) / 2
    if (missesDisk(pts, center, radius + halfStroke)) {
      next.push(entity)
      continue
    }

    let subject = []
    if (entity.baked) {
      const rings = [pts, ...(entity.holes || [])]
      subject = rings.filter((ring) => ring && ring.length >= 3)
    } else if (filled) {
      // Clipper reads a positive ring as material, so a clockwise drawn
      // loop is flipped before it is subtracted from.
      subject = [signedArea(pts) < 0 ? pts.slice().reverse() : pts]
    } else {
      subject = expandStrokeToPolygons(pts, Boolean(entity.closed), (Number(entity.strokeWidth) || 0) * scale)
    }
    if (!subject.length) {
      next.push(entity)
      continue
    }

    let diff = null
    try {
      diff = booleanDifference(subject, [eraser])
    } catch (err) {
      console.error('[vectorErase] difference failed:', err)
      next.push(entity)
      continue
    }

    const loops = (diff || []).filter((loop) => loop && loop.length >= 3 && absArea(loop) > 0.05)
    const before = totalArea(subject)
    const after = totalArea(loops)
    if (!loops.length) {
      changed = true
      continue
    }
    if (Math.abs(before - after) <= Math.max(AREA_EPS, before * 1e-5)) {
      next.push(entity)
      continue
    }

    changed = true
    const groups = groupRings(loops)
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      next.push({
        id: i === 0 ? entity.id : uid(),
        type: 'region',
        points: group.outer.map((p) => ({ x: p.x, y: p.y })),
        holes: group.holes.map((ring) => ring.map((p) => ({ x: p.x, y: p.y }))),
        closed: true,
        baked: true,
        strokeWidth: entity.strokeWidth,
        lineStyle: 'filled',
        // The traced silhouette stays the silhouette after a bite, and a
        // split island stays in its group so it still moves and scales as one.
        ...(entity.base ? { base: true } : null),
        ...(entity.groupId ? { groupId: entity.groupId } : null),
      })
    }
  }
  return changed ? next : entities
}
