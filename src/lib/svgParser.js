import { SVGLoader } from 'three-stdlib'
import { computePathsBounds } from './pathMetrics.js'

/**
 * Max chord deviation as a fraction of the SVG silhouette's longer side.
 * After `fitInnerCavityPaths` this maps to a printer-irrelevant error
 * (~0.02 mm on a 50 mm cutter). Absolute clamps keep tiny viewBoxes from
 * exploding and huge drawings from under-tessellating.
 */
const SVG_CHORD_ERROR_FRAC = 0.0004
const SVG_CHORD_ERROR_MIN = 1e-4
const SVG_CHORD_ERROR_MAX = 0.5
const SVG_MIN_DT = 1 / 512
const SVG_MAX_SUBDIV_DEPTH = 9

/**
 * Parses an SVG text string into 2D polygon paths (loops of {x, y}).
 *
 * Each Path/Shape curve is tessellated independently by chord-error
 * (flatness) rather than a single `shape.getPoints(128)` budget for the
 * whole contour. The DOM fallback uses the same sampler for circle,
 * ellipse, and `path` `d`, and also accepts polygon/polyline. Outer loops
 * are forced to positive signed area, holes to negative — the same
 * winding convention as `vectorizer.normalizeWinding`.
 */
/**
 * Tessellates an SVG into loops plus a parallel role list.
 * Roles match `stencilSheet.js`: 0 filled cutout, 1 open centerline,
 * 2 closed centerline. Filled art stays a silhouette. Stroke-only art
 * (`fill="none"`) stays a centerline so the stencil can outline it.
 */
export function parseSvgArtwork(svgString) {
  if (!svgString || typeof svgString !== 'string') return { paths: [], roles: [] }

  try {
    const loader = new SVGLoader()
    const svgData = loader.parse(svgString)
    const shapes = []
    const centerlines = []

    for (const pathObj of svgData.paths) {
      if (isCenterlineGraphic(pathObj)) {
        const span = spanOfPath(pathObj)
        const err = clampChordError(SVG_CHORD_ERROR_FRAC * (span || 100))
        for (const sub of pathObj.subPaths || []) {
          const sampled = sampleCenterline(sub, err)
          if (sampled) centerlines.push(sampled)
        }
        continue
      }
      const created = SVGLoader.createShapes(pathObj)
      for (const shape of created) shapes.push(shape)
    }

    if (shapes.length === 0 && centerlines.length === 0) {
      return parseSvgDomFallback(svgString)
    }

    const paths = []
    const roles = []
    if (shapes.length > 0) {
      const chordError = tessellationErrorForShapes(shapes)
      for (const shape of shapes) {
        const outerPoints = sampleClosedPath(shape, chordError)
        if (outerPoints.length >= 3) {
          paths.push(normalizeWinding(outerPoints, true))
          roles.push(0)
        }
        if (shape.holes && shape.holes.length > 0) {
          for (const hole of shape.holes) {
            const holePoints = sampleClosedPath(hole, chordError)
            if (holePoints.length >= 3) {
              paths.push(normalizeWinding(holePoints, false))
              roles.push(0)
            }
          }
        }
      }
    }

    for (const line of centerlines) {
      paths.push(line.points)
      roles.push(line.closed ? 2 : 1)
    }

    if (paths.length === 0) return parseSvgDomFallback(svgString)
    return { paths, roles }
  } catch (err) {
    console.error('SVGLoader parse error, falling back to DOM parser:', err)
    return parseSvgDomFallback(svgString)
  }
}

export function parseSvgToPaths(svgString) {
  return parseSvgArtwork(svgString).paths
}

function nodeTag(node) {
  const name = node?.localName || node?.nodeName || ''
  const raw = String(name).toLowerCase()
  const colon = raw.lastIndexOf(':')
  return colon >= 0 ? raw.slice(colon + 1) : raw
}

function isCenterlineGraphic(pathObj) {
  const style = pathObj.userData?.style || {}
  const tag = nodeTag(pathObj.userData?.node)
  if (tag === 'line' || tag === 'polyline') return true
  const fill = style.fill
  const fillNone = fill == null || fill === 'none' || fill === 'transparent'
  const opacity = Number(style.fillOpacity)
  const invisibleFill = Number.isFinite(opacity) && opacity <= 0
  const stroke = style.stroke
  const hasStroke = Boolean(stroke && stroke !== 'none' && stroke !== 'transparent')
  return (fillNone || invisibleFill) && hasStroke
}

function spanOfPath(pathObj) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const include = (x, y) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const sub of pathObj.subPaths || []) {
    for (const curve of sub.curves || []) includeCurve(curve, include)
  }
  const span = Math.max(maxX - minX, maxY - minY, 0)
  return Number.isFinite(span) ? span : 0
}

function sampleCenterline(subPath, chordError) {
  const curves = subPath?.curves || []
  if (curves.length === 0) return null
  const points = []
  let last = null
  for (const curve of curves) {
    const sampled = sampleCurveAdaptive(curve, chordError)
    for (const p of sampled) {
      const pt = { x: p.x, y: -p.y }
      if (last && pointsEqual(last, pt)) continue
      points.push(pt)
      last = pt
    }
  }
  if (points.length < 2) return null
  const closed =
    Boolean(subPath.autoClose) || (points.length >= 3 && pointsEqual(points[0], points[points.length - 1]))
  if (pointsEqual(points[0], points[points.length - 1])) points.pop()
  if (closed ? points.length < 3 : points.length < 2) return null
  return { points, closed }
}

function strokeRoleForElement(el) {
  const tag = nodeTag(el)
  if (tag === 'line' || tag === 'polyline') return 1
  const fill = (el.getAttribute('fill') || '').trim().toLowerCase()
  const stroke = (el.getAttribute('stroke') || '').trim().toLowerCase()
  const fillNone = fill === 'none' || fill === 'transparent'
  const hasStroke = Boolean(stroke && stroke !== 'none' && stroke !== 'transparent')
  if (!(fillNone && hasStroke)) return 0
  if (tag === 'path') return /z/i.test(el.getAttribute('d') || '') ? 2 : 1
  return 2
}

function parseSvgDomFallback(svgString) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgString, 'image/svg+xml')
  const chordError = tessellationErrorForSvgDoc(doc)
  const paths = []
  const roles = []

  const pushFill = (pts) => {
    const loop = closeLoop(pts)
    if (loop.length >= 3) {
      paths.push(normalizeWinding(loop, true))
      roles.push(0)
    }
  }

  const pushStroke = (pts, role) => {
    const loop = closeLoop(pts)
    const min = role === 1 ? 2 : 3
    if (loop.length >= min) {
      paths.push(loop)
      roles.push(role)
    }
  }

  const pushShape = (el, pts) => {
    const role = strokeRoleForElement(el)
    if (role) pushStroke(pts, role)
    else pushFill(pts)
  }

  for (const r of doc.querySelectorAll('rect')) {
    const x = parseFloat(r.getAttribute('x') || 0)
    const y = parseFloat(r.getAttribute('y') || 0)
    const w = parseFloat(r.getAttribute('width') || 0)
    const h = parseFloat(r.getAttribute('height') || 0)
    if (w > 0 && h > 0) {
      pushShape(r, [
        { x, y: -y },
        { x: x + w, y: -y },
        { x: x + w, y: -(y + h) },
        { x, y: -(y + h) },
      ])
    }
  }

  for (const c of doc.querySelectorAll('circle')) {
    const cx = parseFloat(c.getAttribute('cx') || 0)
    const cy = parseFloat(c.getAttribute('cy') || 0)
    const radius = parseFloat(c.getAttribute('r') || 0)
    if (radius > 0) {
      const err = Math.min(chordError, clampChordError(SVG_CHORD_ERROR_FRAC * 2 * radius))
      pushShape(c, sampleEllipse(cx, cy, radius, radius, err))
    }
  }

  for (const e of doc.querySelectorAll('ellipse')) {
    const cx = parseFloat(e.getAttribute('cx') || 0)
    const cy = parseFloat(e.getAttribute('cy') || 0)
    const rx = parseFloat(e.getAttribute('rx') || 0)
    const ry = parseFloat(e.getAttribute('ry') || 0)
    if (rx > 0 && ry > 0) {
      const err = Math.min(chordError, clampChordError(SVG_CHORD_ERROR_FRAC * 2 * Math.max(rx, ry)))
      pushShape(e, sampleEllipse(cx, cy, rx, ry, err))
    }
  }

  for (const line of doc.querySelectorAll('line')) {
    const x1 = parseFloat(line.getAttribute('x1') || 0)
    const y1 = parseFloat(line.getAttribute('y1') || 0)
    const x2 = parseFloat(line.getAttribute('x2') || 0)
    const y2 = parseFloat(line.getAttribute('y2') || 0)
    pushStroke(
      [
        { x: x1, y: -y1 },
        { x: x2, y: -y2 },
      ],
      1,
    )
  }

  for (const poly of doc.querySelectorAll('polygon, polyline')) {
    pushShape(poly, parseSvgPointsAttr(poly.getAttribute('points')))
  }

  for (const el of doc.querySelectorAll('path')) {
    pushShape(el, sampleSvgPathElement(el, chordError))
  }

  return { paths, roles }
}

/**
 * Normalizes SVG paths: centers them at origin (0,0) and scales to unit box
 */
export function normalizeSvgPaths(paths) {
  if (!paths || paths.length === 0) return []
  const bounds = computePathsBounds(paths)
  if (bounds.width === 0 || bounds.height === 0) return paths

  return paths.map((path) =>
    path.map((pt) => ({
      x: (pt.x - bounds.cx) / Math.max(bounds.width, bounds.height),
      y: (pt.y - bounds.cy) / Math.max(bounds.width, bounds.height),
    })),
  )
}

function clampChordError(error) {
  return Math.max(SVG_CHORD_ERROR_MIN, Math.min(SVG_CHORD_ERROR_MAX, error))
}

function tessellationErrorForSvgDoc(doc) {
  const svg = doc.querySelector('svg')
  const vb = svg?.getAttribute('viewBox')
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number)
    if (p.length >= 4 && Number.isFinite(p[2]) && Number.isFinite(p[3])) {
      return clampChordError(SVG_CHORD_ERROR_FRAC * Math.max(p[2], p[3], 0))
    }
  }
  const w = parseFloat(svg?.getAttribute('width') || '')
  const h = parseFloat(svg?.getAttribute('height') || '')
  const span = Math.max(w > 0 ? w : 0, h > 0 ? h : 0)
  if (span > 0) return clampChordError(SVG_CHORD_ERROR_FRAC * span)
  return clampChordError(0.25)
}

function parseSvgPointsAttr(attr) {
  if (!attr) return []
  const nums = attr
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n))
  const pts = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i], y: -nums[i + 1] })
  }
  return pts
}

function closeLoop(points) {
  if (!points || points.length === 0) return []
  const pts = points.slice()
  if (pts.length >= 2 && pointsEqual(pts[0], pts[pts.length - 1])) pts.pop()
  return pts
}

/** Adaptive ellipse/circle in SVG space, emitted Y-up. */
function sampleEllipse(cx, cy, rx, ry, chordError) {
  const getPoint = (t) => ({
    x: cx + rx * Math.cos(t),
    y: -(cy + ry * Math.sin(t)),
  })
  const t0 = 0
  const t1 = Math.PI * 2
  const p0 = getPoint(t0)
  const p1 = getPoint(t1)
  const out = [p0]
  subdivideParametric(getPoint, t0, t1, p0, p1, chordError, 0, out)
  return closeLoop(out)
}

function sampleSvgPathElement(el, chordError) {
  if (typeof el.getTotalLength !== 'function' || typeof el.getPointAtLength !== 'function') {
    return []
  }
  let total
  try {
    total = el.getTotalLength()
  } catch {
    return []
  }
  if (!(total > 0) || !Number.isFinite(total)) return []

  const getPoint = (s) => {
    const p = el.getPointAtLength(Math.max(0, Math.min(total, s)))
    return { x: p.x, y: -p.y }
  }
  const p0 = getPoint(0)
  const p1 = getPoint(total)
  const out = [p0]
  subdivideParametric(getPoint, 0, total, p0, p1, chordError, 0, out)
  return closeLoop(out)
}

function subdivideParametric(getPoint, t0, t1, a, b, chordError, depth, out) {
  const tm = (t0 + t1) * 0.5
  const m = getPoint(tm)
  const span = t1 - t0
  const q1 = getPoint(t0 + span * 0.25)
  const q3 = getPoint(t0 + span * 0.75)
  const err = Math.max(pointToSegDist(m, a, b), pointToSegDist(q1, a, b), pointToSegDist(q3, a, b))

  if (err <= chordError || depth >= SVG_MAX_SUBDIV_DEPTH || span <= SVG_MIN_DT) {
    if (!pointsEqual(out[out.length - 1], b)) out.push(b)
    return
  }

  subdivideParametric(getPoint, t0, tm, a, m, chordError, depth + 1, out)
  subdivideParametric(getPoint, tm, t1, m, b, chordError, depth + 1, out)
}

function tessellationErrorForShapes(shapes) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const include = (x, y) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const includePath = (path) => {
    for (const curve of path.curves || []) includeCurve(curve, include)
  }

  for (const shape of shapes) {
    includePath(shape)
    for (const hole of shape.holes || []) includePath(hole)
  }

  const span = Math.max(maxX - minX, maxY - minY, 0)
  if (!Number.isFinite(span) || span <= 0) return 0.25
  return clampChordError(SVG_CHORD_ERROR_FRAC * span)
}

function includeCurve(curve, include) {
  if (curve.isEllipseCurve) {
    include(curve.aX - curve.xRadius, curve.aY - curve.yRadius)
    include(curve.aX + curve.xRadius, curve.aY + curve.yRadius)
    return
  }
  if (curve.v0) include(curve.v0.x, curve.v0.y)
  if (curve.v1) include(curve.v1.x, curve.v1.y)
  if (curve.v2) include(curve.v2.x, curve.v2.y)
  if (curve.v3) include(curve.v3.x, curve.v3.y)
  if (curve.points) {
    for (const p of curve.points) include(p.x, p.y)
  }
}

/** Y-up engine points from a closed Three.js Path/Shape, sampled per-curve. */
function sampleClosedPath(path, chordError) {
  const curves = path.curves || []
  if (curves.length === 0) return []

  const points = []
  let last = null

  for (const curve of curves) {
    const sampled = sampleCurveAdaptive(curve, chordError)
    for (const p of sampled) {
      const pt = { x: p.x, y: -p.y }
      if (last && pointsEqual(last, pt)) continue
      points.push(pt)
      last = pt
    }
  }

  if (points.length >= 2 && pointsEqual(points[0], points[points.length - 1])) {
    points.pop()
  }
  return points
}

/**
 * Adaptive chord-error tessellation of one Three.js curve. Lines stay as
 * their two endpoints; cubics/quads/arcs/splines subdivide until the
 * sampled midpoint (and quarter-points, to catch S-bends) deviate from
 * the chord by at most `chordError`.
 */
function sampleCurveAdaptive(curve, chordError) {
  const p0 = curve.getPoint(0)
  const p1 = curve.getPoint(1)

  if (curve.isLineCurve || curve.isLineCurve3) {
    return [p0, p1]
  }

  const out = [p0]
  subdivideCurve(curve, 0, 1, p0, p1, chordError, 0, out)
  return out
}

function subdivideCurve(curve, t0, t1, a, b, chordError, depth, out) {
  const tm = (t0 + t1) * 0.5
  const m = curve.getPoint(tm)
  const span = t1 - t0
  const q1 = curve.getPoint(t0 + span * 0.25)
  const q3 = curve.getPoint(t0 + span * 0.75)
  const err = Math.max(pointToSegDist(m, a, b), pointToSegDist(q1, a, b), pointToSegDist(q3, a, b))

  if (err <= chordError || depth >= SVG_MAX_SUBDIV_DEPTH || span <= SVG_MIN_DT) {
    out.push(b)
    return
  }

  subdivideCurve(curve, t0, tm, a, m, chordError, depth + 1, out)
  subdivideCurve(curve, tm, t1, m, b, chordError, depth + 1, out)
}

function pointToSegDist(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function signedPolygonArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

/** Outer loops → positive area, holes → negative. Reverses in place. */
function normalizeWinding(points, isOuter) {
  const isPositive = signedPolygonArea(points) > 0
  if (isPositive !== isOuter) points.reverse()
  return points
}

function pointsEqual(a, b) {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}
