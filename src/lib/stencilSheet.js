import {
  ClipType,
  EndType,
  FillRule,
  JoinType,
  PolyTree64,
  booleanOpWithPolyTree,
  inflatePaths,
} from 'clipper2-ts'
import {
  booleanDifference,
  booleanIntersection,
  booleanUnion,
  fromClipperPath,
  fromClipperPaths,
  toClipperPaths,
} from './clipperWrapper.js'
import { fitPathsToSize, measureFit } from './pathMetrics.js'
import { unionDrawingStrokes } from './vectorStroke.js'

/**
 * Stencil sheet for a cutting plotter (Silhouette Cameo and the like).
 *
 * The artwork is scaled to `designWidth` × `designHeight` first. Cut gap
 * and bridge width are absolute millimetres after that. Inner islands
 * (the counter of an O, the inside of a stroked outline) are held by
 * rectangular tabs subtracted from the cut region. Every copy is then
 * boolean-unioned so the exported SVG has each cut edge exactly once.
 *
 * Path roles, parallel to the point loops:
 *   0 filled cutout
 *   1 open centerline (stroke it)
 *   2 closed centerline (stroke it)
 */

export const ARTWORK_FILL = 0
export const ARTWORK_OPEN_STROKE = 1
export const ARTWORK_CLOSED_STROKE = 2

const SCALE = 10000
const MAX_REPEAT = 10
const MAX_BRIDGES = 8

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNum(value, min, max, fallback))
}

function signedArea(poly) {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function totalAbsArea(paths) {
  let area = 0
  for (const loop of paths || []) {
    if (loop?.length >= 3) area += Math.abs(signedArea(loop))
  }
  return area
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

function centroid(poly) {
  let twice = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const cross = p.x * q.y - q.x * p.y
    twice += cross
    cx += (p.x + q.x) * cross
    cy += (p.y + q.y) * cross
  }
  if (Math.abs(twice) < 1e-8) {
    let x = 0
    let y = 0
    for (const p of poly) {
      x += p.x
      y += p.y
    }
    const n = poly.length || 1
    return { x: x / n, y: y / n }
  }
  return { x: cx / (3 * twice), y: cy / (3 * twice) }
}

function interiorPoint(poly) {
  if (!poly || poly.length < 3) return null
  const c = centroid(poly)
  if (pointInPolygon(c, poly)) return c

  const sign = signedArea(poly) >= 0 ? 1 : -1
  let best = null
  let bestLen = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (!(len > bestLen)) continue
    const nx = (-dy / len) * sign
    const ny = (dx / len) * sign
    const step = Math.min(1.5, len * 0.25)
    const p = { x: (a.x + b.x) / 2 + nx * step, y: (a.y + b.y) / 2 + ny * step }
    if (!pointInPolygon(p, poly)) continue
    best = p
    bestLen = len
  }
  return best
}

function pathBounds(poly) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of poly) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, maxX, minY, maxY }
}

function rayFirstHit(origin, dx, dy, polygon) {
  let bestT = Infinity
  let best = null
  const n = polygon.length
  for (let i = 0; i < n; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % n]
    const ex = b.x - a.x
    const ey = b.y - a.y
    const det = dx * ey - dy * ex
    if (Math.abs(det) < 1e-12) continue
    const t = ((a.x - origin.x) * ey - (a.y - origin.y) * ex) / det
    const u = ((a.x - origin.x) * dy - (a.y - origin.y) * dx) / det
    if (t > 1e-4 && u >= -1e-6 && u <= 1 + 1e-6 && t < bestT) {
      bestT = t
      best = { x: origin.x + dx * t, y: origin.y + dy * t, t }
    }
  }
  return best
}

function measureGap(origin, angle, hole, parent) {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const holeHit = rayFirstHit(origin, dx, dy, hole)
  const parentHit = rayFirstHit(origin, dx, dy, parent)
  if (!holeHit || !parentHit) return null
  if (parentHit.t <= holeHit.t + 0.05) return null
  return {
    holeHit,
    parentHit,
    dx,
    dy,
    distance: parentHit.t - holeHit.t,
  }
}

function angleDelta(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2)
  if (d > Math.PI) d = Math.PI * 2 - d
  return d
}

function bridgeRect(ax, ay, bx, by, width) {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (!(len > 1e-4)) return null
  const px = (-dy / len) * (width / 2)
  const py = (dx / len) * (width / 2)
  return [
    { x: ax + px, y: ay + py },
    { x: bx + px, y: by + py },
    { x: bx - px, y: by - py },
    { x: ax - px, y: ay - py },
  ]
}

function usableLoops(paths, minPoints) {
  return (paths || []).filter((loop) => loop && loop.length >= minPoints)
}

function unionAll(paths) {
  const clean = usableLoops(paths, 3)
  if (clean.length === 0) return []
  try {
    const merged = booleanUnion(clean, null)
    if (merged?.length) return merged
  } catch (err) {
    console.error('[stencil] union failed:', err)
  }
  // Never hand the raw loops to the extruder: they still overlap.
  // Pairwise union drops a loop that will not merge instead of stacking it.
  let acc = []
  for (const loop of clean) {
    if (acc.length === 0) {
      acc = [loop]
      continue
    }
    try {
      const next = booleanUnion(acc, [loop])
      if (next?.length) acc = next
    } catch (err) {
      console.error('[stencil] union skipped a loop:', err)
    }
  }
  return acc
}

function unionTree(paths) {
  const tree = new PolyTree64()
  const clean = usableLoops(paths, 3)
  if (clean.length === 0) return tree
  booleanOpWithPolyTree(ClipType.Union, toClipperPaths(clean, SCALE), null, tree, FillRule.NonZero)
  return tree
}

function walkNodes(node, visit) {
  visit(node)
  for (let i = 0; i < node.count; i++) walkNodes(node.child(i), visit)
}

function countHoles(paths) {
  let n = 0
  const tree = unionTree(paths)
  walkNodes(tree, (node) => {
    if (node.isHole && node.polygon && node.polygon.length >= 3) n += 1
  })
  return n
}

function collectIslands(paths) {
  const islands = []
  const tree = unionTree(paths)
  const walk = (node, parentContour) => {
    const contour = node.polygon && node.polygon.length >= 3 ? fromClipperPath(node.polygon, SCALE) : null
    if (node.isHole && contour && parentContour) {
      islands.push({ hole: contour, parent: parentContour })
    }
    const nextParent = !node.isHole && contour ? contour : parentContour
    for (let i = 0; i < node.count; i++) walk(node.child(i), nextParent)
  }
  walk(tree, null)
  return islands
}

function axisSlots(origin, hole, parent, count, horizontal) {
  const primary = horizontal ? 0 : Math.PI / 2
  const opposite = horizontal ? Math.PI : -Math.PI / 2
  if (count === 1) {
    const a = measureGap(origin, primary, hole, parent)
    const b = measureGap(origin, opposite, hole, parent)
    const angle = !b || (a && a.distance <= b.distance) ? primary : opposite
    return [{ origin, angle }]
  }
  if (count === 2) {
    return [
      { origin, angle: primary },
      { origin, angle: opposite },
    ]
  }

  const bounds = pathBounds(hole)
  const span = horizontal ? bounds.maxY - bounds.minY : bounds.maxX - bounds.minX
  const pairs = Math.ceil(count / 2)
  const slots = []
  for (let i = 0; i < pairs && slots.length < count; i++) {
    const t = (i + 0.5) / pairs
    const offset = (t - 0.5) * span * 0.65
    const shifted = horizontal
      ? { x: origin.x, y: origin.y + offset }
      : { x: origin.x + offset, y: origin.y }
    const at = pointInPolygon(shifted, hole) ? shifted : origin
    slots.push({ origin: at, angle: primary })
    if (slots.length < count) slots.push({ origin: at, angle: opposite })
  }
  return slots
}

function shortestSlots(origin, hole, parent, count) {
  const samples = 64
  const scored = []
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2
    const gap = measureGap(origin, angle, hole, parent)
    if (!gap || gap.distance < 0.05) continue
    scored.push({ angle, distance: gap.distance })
  }
  scored.sort((a, b) => a.distance - b.distance)
  const minSep = ((Math.PI * 2) / count) * 0.55
  const picked = []
  for (const item of scored) {
    if (picked.every((p) => angleDelta(p.angle, item.angle) >= minSep)) picked.push(item)
    if (picked.length === count) break
  }
  if (picked.length < count) {
    for (const item of scored) {
      if (picked.some((p) => angleDelta(p.angle, item.angle) < 0.3)) continue
      picked.push(item)
      if (picked.length === count) break
    }
  }
  return picked.map((item) => ({ origin, angle: item.angle }))
}

function slotsForIsland(strategy, count, origin, hole, parent) {
  if (strategy === 'horizontal') return axisSlots(origin, hole, parent, count, true)
  if (strategy === 'vertical') return axisSlots(origin, hole, parent, count, false)
  if (strategy === 'even') {
    const slots = []
    for (let i = 0; i < count; i++) {
      slots.push({ origin, angle: -Math.PI / 2 + (i * Math.PI * 2) / count })
    }
    return slots
  }
  return shortestSlots(origin, hole, parent, count)
}

function gapWithNudge(origin, angle, hole, parent) {
  const direct = measureGap(origin, angle, hole, parent)
  if (direct) return direct
  for (const delta of [0.14, -0.14, 0.32, -0.32]) {
    const nudged = measureGap(origin, angle + delta, hole, parent)
    if (nudged) return nudged
  }
  return null
}

function rectsForIsland(island, slots, width, overlapScale) {
  const rects = []
  for (const slot of slots) {
    const gap = gapWithNudge(slot.origin, slot.angle, island.hole, island.parent)
    if (!gap) continue
    const overlap = Math.max(0.25, Math.min(gap.distance * 0.55, 1.5)) * overlapScale
    const rect = bridgeRect(
      gap.holeHit.x - gap.dx * overlap,
      gap.holeHit.y - gap.dy * overlap,
      gap.parentHit.x + gap.dx * overlap,
      gap.parentHit.y + gap.dy * overlap,
      width,
    )
    if (rect) rects.push(rect)
  }
  return rects
}

/** Dragged tabs shorter than this are a click, not a segment. */
export const MIN_MANUAL_BRIDGE_LENGTH = 0.2

export function isManualBridgePlacement(settings) {
  if (!settings || settings.stencilBridges === false) return false
  return settings.placement === 'manual' || settings.bridgeStrategy === 'manual'
}

/**
 * Sheet-space point the user can still attach a bridge to. One board
 * of padding past the blank keeps a tab that starts in the margin, and
 * rejects coordinates that would blow up the Clipper integer grid.
 */
export function sheetPointInReach(x, y, boardW, boardH) {
  const px = Number(x)
  const py = Number(y)
  const bw = Number(boardW)
  const bh = Number(boardH)
  if (![px, py, bw, bh].every(Number.isFinite)) return false
  if (!(bw > 0) || !(bh > 0)) return false
  const pad = Math.max(bw, bh)
  return px >= -pad && py >= -pad && px <= bw + pad && py <= bh + pad
}

function svgPointToModel(sx, sy, boardW, boardH) {
  return { x: sx - boardW / 2, y: boardH / 2 - sy }
}

/**
 * Rectangle of size `length × width`, centered on the segment and rotated
 * by its angle. `length = hypot(dx, dy)`, `theta = atan2(dy, dx)`,
 * midpoint `((x1+x2)/2, (y1+y2)/2)`. The four corners are the Clipper loop
 * that `booleanUnion` welds onto the sheet. Works in either Y-up model
 * space or Y-down sheet space, as long as both endpoints share that frame.
 */
export function orientedBridgeRect(ax, ay, bx, by, width) {
  const x1 = Number(ax)
  const y1 = Number(ay)
  const x2 = Number(bx)
  const y2 = Number(by)
  const span = Number(width)
  if (![x1, y1, x2, y2, span].every(Number.isFinite)) return null
  if (!(span > 0)) return null
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (!(length >= MIN_MANUAL_BRIDGE_LENGTH)) return null
  const theta = Math.atan2(dy, dx)
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const hx = length / 2
  const hy = span / 2
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ].map((corner) => ({
    x: mx + corner.x * cos - corner.y * sin,
    y: my + corner.x * sin + corner.y * cos,
  }))
}

function readBridgeSegment(entry, boardW, boardH) {
  const x1 = Number(entry?.p1?.x)
  const y1 = Number(entry?.p1?.y)
  const x2 = Number(entry?.p2?.x)
  const y2 = Number(entry?.p2?.y)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  if (!sheetPointInReach(x1, y1, boardW, boardH) || !sheetPointInReach(x2, y2, boardW, boardH)) return null
  if (!(Math.hypot(x2 - x1, y2 - y1) >= MIN_MANUAL_BRIDGE_LENGTH)) return null
  return {
    p1: { x: x1, y: y1 },
    p2: { x: x2, y: y2 },
  }
}

function svgPolygon(rect, boardW, boardH) {
  return rect.map((p) => ({
    x: p.x + boardW / 2,
    y: boardH / 2 - p.y,
  }))
}

/**
 * One dragged segment becomes one rotated tab. Endpoints are preview
 * millimetres (origin top-left, Y down). The rectangle is built in the
 * Y-up model frame, then unioned onto the board by `fuseManualBoard`.
 */
function buildManualBridges(settings, layout) {
  const width = clampNum(settings.bridgeWidth ?? 1.5, 0.2, 8, 1.5)
  const segments = Array.isArray(settings.manualBridges) ? settings.manualBridges : []
  const rects = []
  const markers = []
  for (const entry of segments) {
    const seg = readBridgeSegment(entry, layout.boardW, layout.boardH)
    if (!seg) continue
    const a = svgPointToModel(seg.p1.x, seg.p1.y, layout.boardW, layout.boardH)
    const b = svgPointToModel(seg.p2.x, seg.p2.y, layout.boardW, layout.boardH)
    const rect = orientedBridgeRect(a.x, a.y, b.x, b.y, width)
    if (!rect) continue
    rects.push(rect)
    markers.push(svgPolygon(rect, layout.boardW, layout.boardH))
  }
  return { rects, markers }
}

/**
 * Manual tabs are unioned onto the board, then the cut (with those tabs
 * already removed) is subtracted. A second union puts a tab back if the
 * cut still covered it.
 */
function fuseManualBoard(board, cuts, tabs) {
  let base = [board]
  if (tabs.length) {
    try {
      const joined = booleanUnion([board], tabs)
      if (joined?.length) base = joined
    } catch (err) {
      console.error('[stencil] manual bridge union failed:', err)
    }
  }
  let plastic = base
  if (cuts?.length) {
    try {
      const cut = booleanDifference(base, cuts)
      if (cut?.length) plastic = cut
    } catch (err) {
      console.error('[stencil] sheet difference failed:', err)
    }
  }
  if (tabs.length && plastic.length) {
    try {
      const joined = booleanUnion(plastic, tabs)
      if (joined?.length) plastic = joined
    } catch (err) {
      console.error('[stencil] bridge union failed:', err)
    }
  }
  const resolved = cleanRegion(clipInside(plastic, board))
  return resolved.length ? resolved : [board]
}

function subtractKeepingCut(cuts, rects) {
  if (!rects?.length) return cuts
  let next = null
  try {
    next = booleanDifference(cuts, rects)
  } catch (err) {
    console.error('[stencil] bridge subtract failed:', err)
    return cuts
  }
  if (!next?.length) return cuts
  const before = totalAbsArea(cuts)
  const after = totalAbsArea(next)
  if (!(after > 0.05) || after < before * 0.04) return cuts
  return next
}

function applyBridges(cuts, settings) {
  const sourceIslands = countHoles(cuts)
  if (settings.stencilBridges === false || sourceIslands === 0) {
    return { cuts, rects: [], sourceIslands }
  }

  if (settings.placement === 'manual' || settings.bridgeStrategy === 'manual') {
    return { cuts, rects: [], sourceIslands }
  }

  const count = clampInt(settings.bridgeCount ?? 2, 1, MAX_BRIDGES, 2)
  const width = clampNum(settings.bridgeWidth ?? 1.5, 0.2, 8, 1.5)
  const strategy = settings.bridgeStrategy || 'shortest'
  const islands = collectIslands(cuts).slice(0, 80)
  let current = cuts
  const accepted = []

  for (const island of islands) {
    const origin = interiorPoint(island.hole)
    if (!origin) continue
    const slots = slotsForIsland(strategy, count, origin, island.hole, island.parent)
    const holesBefore = countHoles(current)
    let used = rectsForIsland(island, slots, width, 1)
    let next = subtractKeepingCut(current, used)
    if (countHoles(next) >= holesBefore) {
      const wider = rectsForIsland(island, slots, width, 2.4)
      const retry = subtractKeepingCut(current, wider)
      if (countHoles(retry) < countHoles(next)) {
        used = wider
        next = retry
      }
    }
    if (countHoles(next) < holesBefore) accepted.push(...used)
    current = next
  }

  // One union, so crossing tabs become a single clip instead of stacked rectangles.
  return { cuts: current, rects: unionAll(accepted), sourceIslands }
}

function clipInside(paths, board) {
  if (!paths?.length) return []
  try {
    const inside = booleanIntersection(paths, [board])
    if (inside?.length) return inside
  } catch (err) {
    console.error('[stencil] sheet clip failed:', err)
  }
  return paths
}

/**
 * One NonZero region: overlaps, coincident edges, and self-intersections
 * are resolved, then slivers are dropped. A second union absorbs an island
 * that the sliver filter orphaned inside a filled face, so the extruder
 * never sees two contours covering the same plastic.
 */
function cleanRegion(paths) {
  const unioned = unionAll(paths).filter((loop) => loop.length >= 3 && Math.abs(signedArea(loop)) >= 0.05)
  return unionAll(unioned)
}

/**
 * Sheet plastic is the board with the design removed, then the bridges
 * fused back on. Both booleans run in Clipper before any extrusion, so a
 * bridge rectangle cannot survive as a second path on top of the sheet.
 */
function fusePlastic(board, design, tabs) {
  let plastic = [board]
  if (design.length) {
    try {
      const cut = booleanDifference([board], design)
      if (cut?.length) plastic = cut
    } catch (err) {
      console.error('[stencil] sheet difference failed:', err)
    }
  }
  if (tabs.length && plastic.length) {
    try {
      const joined = booleanUnion(plastic, tabs)
      if (joined?.length) plastic = joined
    } catch (err) {
      console.error('[stencil] bridge union failed:', err)
    }
  }
  const resolved = cleanRegion(clipInside(plastic, board))
  return resolved.length ? resolved : [board]
}

function offsetLoops(paths, deltaMm, endType) {
  const minPoints = endType === EndType.Round ? 2 : 3
  const usable = (paths || []).filter((loop) => loop && loop.length >= minPoints)
  if (!usable.length || !(deltaMm > 0)) return []
  try {
    const solution = inflatePaths(
      toClipperPaths(usable, SCALE),
      deltaMm * SCALE,
      JoinType.Round,
      endType,
      2,
      0.01 * SCALE,
    )
    return fromClipperPaths(solution, SCALE).filter((loop) => loop.length >= 3)
  } catch (err) {
    console.error('[stencil] stroke offset failed:', err)
    return []
  }
}

/**
 * A closed centerline offset emits the two sides of the stroke. Opposite
 * windings union into a band (the plastic that will be cut away). If both
 * sides come back with the same winding, subtract the inner loop so the
 * result is still that band and not a filled disk.
 */
function asStrokeBand(loops) {
  const unioned = unionAll(loops)
  if (unioned.length === 0) return []
  if (countHoles(unioned) > 0 || loops.length < 2) return unioned
  const ranked = [...loops]
    .filter((loop) => loop.length >= 3)
    .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  if (ranked.length < 2) return unioned
  try {
    const band = booleanDifference([ranked[0]], ranked.slice(1))
    if (band?.length && countHoles(band) > 0) return band
  } catch (err) {
    console.error('[stencil] stroke band rebuild failed:', err)
  }
  return unioned
}

function roleFor(roles, index, mode) {
  const raw = roles && index < roles.length ? Number(roles[index]) : ARTWORK_FILL
  if (mode === 'filled') return ARTWORK_FILL
  if (mode === 'centerline') {
    return raw === ARTWORK_OPEN_STROKE ? ARTWORK_OPEN_STROKE : ARTWORK_CLOSED_STROKE
  }
  if (raw === ARTWORK_OPEN_STROKE || raw === ARTWORK_CLOSED_STROKE) return raw
  return ARTWORK_FILL
}

function mirrorPaths(paths) {
  return paths.map((loop) => {
    const mirrored = loop.map((p) => ({ x: -p.x, y: p.y }))
    mirrored.reverse()
    return mirrored
  })
}

function translatePaths(paths, dx, dy) {
  return paths.map((loop) => loop.map((p) => ({ x: p.x + dx, y: p.y + dy })))
}

function rectPath(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

function layoutGrid(settings) {
  const boardW = clampNum(settings.stencilBoardWidth, 20, 2000, 210)
  const boardH = clampNum(settings.stencilBoardHeight, 20, 2000, 210)
  const rows = clampInt(settings.rows, 1, MAX_REPEAT, 1)
  const columns = clampInt(settings.columns, 1, MAX_REPEAT, 1)
  let margin = clampNum(settings.stencilMargin, 0, 200, 10)
  margin = Math.min(margin, Math.max(0, Math.min(boardW, boardH) / 2 - 2))
  const innerW = boardW - margin * 2
  const innerH = boardH - margin * 2

  let cellW = clampNum(settings.designWidth, 5, 2000, 80)
  let cellH = clampNum(settings.designHeight, 5, 2000, 80)
  let scale = 1
  if (innerW > 4 && innerH > 4) {
    scale = Math.min(1, innerW / (columns * cellW), innerH / (rows * cellH))
    if (scale < 1) {
      cellW *= scale
      cellH *= scale
    }
  }

  const extraX = innerW - columns * cellW
  const extraY = innerH - rows * cellH
  const gapX = columns > 1 ? Math.max(0, extraX) / (columns - 1) : 0
  const gapY = rows > 1 ? Math.max(0, extraY) / (rows - 1) : 0
  const gridW = columns * cellW + (columns - 1) * gapX
  const gridH = rows * cellH + (rows - 1) * gapY
  const originX = -boardW / 2 + (boardW - gridW) / 2
  const originY = -boardH / 2 + (boardH - gridH) / 2

  return {
    boardW,
    boardH,
    rows,
    columns,
    margin,
    cellW,
    cellH,
    gapX,
    gapY,
    scale,
    originX,
    originY,
    innerW,
    innerH,
  }
}

function buildMasterCuts(paths, roles, layout, settings, drawings = null, replaceBase = false) {
  const mode = settings.stencilArtwork || 'auto'
  const resolved = paths.map((_, index) => roleFor(roles, index, mode))
  const allStroke = resolved.every((role) => role !== ARTWORK_FILL)
  const thickness = clampNum(settings.cutThickness, 0.2, 12, 1.2)
  const shrink = allStroke ? thickness : 0
  const boxW = Math.max(layout.cellW - shrink, Math.min(layout.cellW, 1))
  const boxH = Math.max(layout.cellH - shrink, Math.min(layout.cellH, 1))
  const keepAspect = settings.designAspectLocked !== false
  const fitted = fitPathsToSize(paths, boxW, boxH, keepAspect)

  const fills = []
  const openStrokes = []
  const closedStrokes = []
  fitted.forEach((loop, index) => {
    const role = resolved[index]
    if (role === ARTWORK_OPEN_STROKE) openStrokes.push(loop)
    else if (role === ARTWORK_CLOSED_STROKE) closedStrokes.push(loop)
    else if (loop.length >= 3) fills.push(loop)
  })

  // When the editor owns the silhouette the traced loops are replaced by the
  // edited regions in `drawings`. `paths` still defines the fit (and so the
  // scale), but contributes no material of its own.
  const pieces = []
  if (!replaceBase) {
    if (fills.length) pieces.push(...fills)
    if (openStrokes.length) pieces.push(...offsetLoops(openStrokes, thickness / 2, EndType.Round))
    if (closedStrokes.length) pieces.push(...asStrokeBand(offsetLoops(closedStrokes, thickness / 2, EndType.Joined)))
  }
  const master = unionAll(pieces)
  if (!drawings?.length) return master
  const fit = measureFit(paths, boxW, boxH, keepAspect)
  if (!fit) return master
  return unionDrawingStrokes(master, drawings, fit, false, { replaceBase })
}

function mirrorDrawingPoints(drawings) {
  if (!drawings?.length) return []
  return drawings.map((stroke) => {
    const points = (stroke.points || []).map((p) => ({ x: -Number(p.x), y: Number(p.y) }))
    // Negating X reverses winding. Baked fills are already polygons, so
    // restore the sign. Open centerlines are offset later and keep order
    // so a dashed pattern still starts on the same vertex.
    if (stroke.baked) points.reverse()
    return {
      closed: Boolean(stroke.closed) || Boolean(stroke.baked),
      strokeWidth: stroke.strokeWidth,
      lineStyle: stroke.lineStyle === 'dashed' || stroke.lineStyle === 'filled' ? stroke.lineStyle : 'solid',
      baked: Boolean(stroke.baked),
      points,
    }
  })
}

function emptySheet(layout) {
  const board = rectPath(-layout.boardW / 2, -layout.boardH / 2, layout.boardW, layout.boardH)
  return {
    boardWidth: layout.boardW,
    boardHeight: layout.boardH,
    margin: layout.margin,
    rows: layout.rows,
    columns: layout.columns,
    cellWidth: layout.cellW,
    cellHeight: layout.cellH,
    gapX: layout.gapX,
    gapY: layout.gapY,
    scale: layout.scale,
    sourceIslands: 0,
    openIslands: 0,
    bridgeMarkers: [],
    cutPaths: [],
    plasticPaths: [board],
  }
}

/**
 * Builds the stencil in millimetres, Y-up, with the sheet centered on the
 * origin (the same frame the 3D preview uses). `cutPaths` is the material
 * the plotter removes. `plasticPaths` is the sheet that remains.
 */
export function buildStencilSheet(sourcePaths, settings, roles = null, drawings = null, replaceBase = false) {
  const layout = layoutGrid(settings || {})
  if (!sourcePaths?.length || layout.innerW < 4 || layout.innerH < 4) return emptySheet(layout)

  const opts = settings || {}
  const mirror = opts.mirrorDesign !== false
  const artwork = mirror ? mirrorPaths(sourcePaths) : sourcePaths
  const artworkDrawings = mirror ? mirrorDrawingPoints(drawings) : drawings
  const master = buildMasterCuts(artwork, roles, layout, opts, artworkDrawings, replaceBase)
  if (!master.length) return emptySheet(layout)

  const manual = isManualBridgePlacement(opts)
  // Manual segments are in sheet space, so the island search never runs.
  const bridged = manual ? { rects: [], sourceIslands: countHoles(master) } : applyBridges(master, opts)
  const designCopies = []
  const tabCopies = []
  for (let row = 0; row < layout.rows; row++) {
    for (let column = 0; column < layout.columns; column++) {
      const cx = layout.originX + column * (layout.cellW + layout.gapX) + layout.cellW / 2
      const cy = layout.originY + row * (layout.cellH + layout.gapY) + layout.cellH / 2
      // The design stays whole. Tabs are unioned onto the board afterwards
      // so two bridges cannot leave overlapping edges inside the cut.
      designCopies.push(...translatePaths(master, cx, cy))
      if (!manual && bridged.rects.length) tabCopies.push(...translatePaths(bridged.rects, cx, cy))
    }
  }

  const board = rectPath(-layout.boardW / 2, -layout.boardH / 2, layout.boardW, layout.boardH)
  const design = cleanRegion(clipInside(unionAll(designCopies), board))

  let tabs = []
  let bridgeMarkers = []
  if (manual) {
    const placed = buildManualBridges(opts, layout)
    bridgeMarkers = placed.markers
    if (placed.rects.length) tabs = cleanRegion(clipInside(unionAll(placed.rects), board))
  } else if (tabCopies.length) {
    tabs = cleanRegion(clipInside(unionAll(tabCopies), board))
  }

  let cutPaths = design
  if (tabs.length) cutPaths = cleanRegion(subtractKeepingCut(design, tabs))

  const plastic = manual ? fuseManualBoard(board, cutPaths, tabs) : fusePlastic(board, design, tabs)

  return {
    boardWidth: layout.boardW,
    boardHeight: layout.boardH,
    margin: layout.margin,
    rows: layout.rows,
    columns: layout.columns,
    cellWidth: layout.cellW,
    cellHeight: layout.cellH,
    gapX: layout.gapX,
    gapY: layout.gapY,
    scale: layout.scale,
    sourceIslands: bridged.sourceIslands,
    openIslands: countHoles(cutPaths),
    bridgeMarkers,
    cutPaths,
    plasticPaths: plastic.length ? plastic : [board],
  }
}

function fmt(n) {
  const rounded = Math.round(Number(n) * 1000) / 1000
  if (!Number.isFinite(rounded)) return '0'
  return String(rounded)
}

function contourToSvgD(points, boardW, boardH) {
  const xy = (p) => `${fmt(p.x + boardW / 2)} ${fmt(boardH / 2 - p.y)}`
  let d = `M ${xy(points[0])}`
  for (let i = 1; i < points.length; i++) d += ` L ${xy(points[i])}`
  return `${d} Z`
}

/** Hairline cut contours in millimetres, Y-down, one closed path per union edge. */
export function buildStencilSvg(sheet) {
  const w = sheet?.boardWidth || 0
  const h = sheet?.boardHeight || 0
  const paths = (sheet?.cutPaths || [])
    .filter((loop) => loop && loop.length >= 3)
    .map((loop) => `    <path d="${contourToSvgD(loop, w, h)}" />`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">
  <!-- Stencil sheet ${fmt(w)} x ${fmt(h)} mm. Contours are a boolean union: each cut edge is traced once. In Silhouette Studio set this layer to Cut. -->
  <g id="cuts" fill="none" stroke="#000000" stroke-width="0.1">
${paths}
  </g>
</svg>
`
}

/** Board plus cut contours, for an even-odd plastic preview. */
export function buildStencilPreviewD(sheet) {
  const w = sheet?.boardWidth || 0
  const h = sheet?.boardHeight || 0
  const board = `M 0 0 H ${fmt(w)} V ${fmt(h)} H 0 Z`
  const cuts = (sheet?.cutPaths || [])
    .filter((loop) => loop && loop.length >= 3)
    .map((loop) => contourToSvgD(loop, w, h))
    .join(' ')
  return `${board} ${cuts}`.trim()
}
