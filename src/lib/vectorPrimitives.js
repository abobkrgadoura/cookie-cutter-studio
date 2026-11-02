/**
 * Drag primitives and dash subdivision for the 2D editor.
 *
 * Coordinates are whatever frame the caller is in (editor pixels on the
 * canvas, millimetres once a stroke has been fitted). Closed shapes do not
 * repeat the first vertex; `closed` on the entity closes them.
 */

export const CIRCLE_SEGMENTS = 64

function finitePoint(point) {
  const x = Number(point?.x)
  const y = Number(point?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

export function linePoints(start, current) {
  const a = finitePoint(start)
  const b = finitePoint(current)
  if (!a || !b) return []
  return [a, b]
}

/** Axis-aligned box from the drag diagonal. Four corners, unclosed. */
export function rectanglePoints(start, current) {
  const a = finitePoint(start)
  const b = finitePoint(current)
  if (!a || !b) return []
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}

/**
 * Closed polyline centered on `center`. Vertex 0 sits at angle 0
 * (`center + (R, 0)`). The first point is not repeated at the end.
 */
export function circlePoints(center, radius, segments = CIRCLE_SEGMENTS) {
  const c = finitePoint(center)
  const r = Number(radius)
  const count = Math.max(3, Math.round(Number(segments) || CIRCLE_SEGMENTS))
  if (!c || !(r > 0)) return []
  const points = []
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    points.push({
      x: c.x + r * Math.cos(angle),
      y: c.y + r * Math.sin(angle),
    })
  }
  return points
}

function cleanChain(points, closed) {
  const out = []
  for (const raw of points || []) {
    const p = finitePoint(raw)
    if (!p) continue
    const prev = out[out.length - 1]
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-6) continue
    out.push(p)
  }
  if (closed && out.length > 1) {
    const first = out[0]
    const last = out[out.length - 1]
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) out.pop()
  }
  return out
}

/**
 * Live drag preview / commit geometry.
 * `minSize` is the minimum length, side, or radius in the same units as
 * the points. Returns null when the drag is still degenerate.
 */
export function buildDragPrimitive(kind, origin, current, minSize = 0.25) {
  const min = Number(minSize) > 0 ? Number(minSize) : 0
  if (kind === 'line') {
    const points = linePoints(origin, current)
    if (points.length < 2) return null
    if (Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) < min) return null
    return { points, closed: false }
  }
  if (kind === 'rect') {
    const points = rectanglePoints(origin, current)
    if (points.length < 4) return null
    const width = Math.abs(points[1].x - points[0].x)
    const height = Math.abs(points[2].y - points[1].y)
    if (width < min || height < min) return null
    return { points, closed: true }
  }
  if (kind === 'circle') {
    const c = finitePoint(origin)
    const p = finitePoint(current)
    if (!c || !p) return null
    const radius = Math.hypot(p.x - c.x, p.y - c.y)
    if (radius < min) return null
    return { points: circlePoints(c, radius), closed: true }
  }
  return null
}

function pointOnEdge(edge, dist) {
  const t = edge.len > 0 ? dist / edge.len : 0
  return {
    x: edge.ax + (edge.bx - edge.ax) * t,
    y: edge.ay + (edge.by - edge.ay) * t,
  }
}

function pushDistinct(chain, point) {
  const prev = chain[chain.length - 1]
  if (prev && Math.hypot(prev.x - point.x, prev.y - point.y) < 1e-6) return
  chain.push(point)
}

/**
 * Splits a centerline into the solid pieces of a cut/gap pattern.
 * Lengths use the same units as the coordinates (millimetres in CAM,
 * editor pixels only for the SVG dash preview). A path shorter than one
 * cut is returned as a single piece. The closing edge is included when
 * `closed` is set.
 */
export function dashCutSegments(points, closed, cutLen, gapLen) {
  const ring = cleanChain(points, closed)
  const minCount = closed ? 3 : 2
  if (ring.length < minCount) return []
  const cut = Number(cutLen)
  const gap = Number(gapLen)
  if (!(cut > 0)) return []

  const edges = []
  const span = closed ? ring.length : ring.length - 1
  for (let i = 0; i < span; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > 1e-9) edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, len })
  }
  if (!edges.length) return []

  if (!(gap > 0)) {
    const whole = [pointOnEdge(edges[0], 0)]
    for (const edge of edges) pushDistinct(whole, { x: edge.bx, y: edge.by })
    return whole.length >= 2 ? [whole] : []
  }

  const cuts = []
  let edgeIndex = 0
  let edgePos = 0
  let cutting = true
  let left = cut
  let chain = null
  let guard = 0
  const guardMax = edges.length * 4 + 8

  while (edgeIndex < edges.length && guard < guardMax) {
    guard += 1
    const edge = edges[edgeIndex]
    const avail = edge.len - edgePos
    if (avail <= 1e-9) {
      edgeIndex += 1
      edgePos = 0
      continue
    }
    const step = Math.min(avail, left)
    if (cutting) {
      if (!chain) chain = [pointOnEdge(edge, edgePos)]
      pushDistinct(chain, pointOnEdge(edge, edgePos + step))
    }
    edgePos += step
    left -= step
    if (left <= 1e-8) {
      if (cutting && chain && chain.length >= 2) cuts.push(chain)
      chain = null
      cutting = !cutting
      left = cutting ? cut : gap
    }
  }
  if (cutting && chain && chain.length >= 2) cuts.push(chain)
  return cuts
}
