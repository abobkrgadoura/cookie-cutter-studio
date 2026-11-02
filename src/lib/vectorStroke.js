import { booleanDifference, booleanUnion, offsetPolygons } from './clipperWrapper.js'
import { measureFit } from './pathMetrics.js'
import { DASH_CUT_MM, DASH_GAP_MM } from './vectorEntities.js'
import { dashCutSegments } from './vectorPrimitives.js'

/**
 * A drawn centerline has no area. Clipper2 inflates it by half the stroke
 * width — `JoinType.Round` plus round caps on open paths (`EndType.Round`)
 * and a closed-polyline join (`EndType.Joined`) on loops — so the boolean
 * engine receives a filled polygon.
 *
 * The offset runs in the fitted millimetre frame, using the same scale the
 * tracer just received. The traced loops are not fitted again, so a stroke
 * cannot shrink the silhouette.
 */

function signedArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function stripConsecutive(points) {
  const out = []
  for (const p of points || []) {
    const x = Number(p?.x)
    const y = Number(p?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const prev = out[out.length - 1]
    if (prev && Math.hypot(x - prev.x, y - prev.y) < 1e-6) continue
    out.push({ x, y })
  }
  return out
}

/**
 * Closed-polyline offset returns the two sides of the ribbon. Opposite
 * windings union into a band. Same winding would fill the disk, so the
 * inner loop is subtracted.
 */
function closedStrokeBand(loops) {
  const solid = (loops || []).filter((loop) => loop && loop.length >= 3)
  if (solid.length < 2) return solid
  let unioned = solid
  try {
    const merged = booleanUnion(solid, [])
    if (merged?.length) unioned = merged
  } catch (err) {
    console.error('[vectorStroke] closed stroke union failed:', err)
  }
  const hasHole = unioned.some((loop) => signedArea(loop) < 0) && unioned.some((loop) => signedArea(loop) > 0)
  if (hasHole) return unioned
  const ranked = [...solid].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  try {
    const band = booleanDifference([ranked[0]], ranked.slice(1))
    if (band?.length) return band
  } catch (err) {
    console.error('[vectorStroke] closed stroke band failed:', err)
  }
  return unioned
}

export function expandStrokeToPolygons(points, closed, strokeWidthMm) {
  const width = Number(strokeWidthMm)
  if (!(width > 0.0001)) return []
  const cleaned = stripConsecutive(points)
  const min = closed ? 3 : 2
  if (cleaned.length < min) return []
  let loops = []
  try {
    loops = offsetPolygons([cleaned], width / 2, {
      endType: closed ? 'closedLine' : 'openRound',
      arcTolerance: 0.05,
    })
  } catch (err) {
    console.error('[vectorStroke] stroke offset failed:', err)
    return []
  }
  const solid = (loops || []).filter((loop) => loop && loop.length >= 3)
  if (!closed) return solid
  return closedStrokeBand(solid)
}

/**
 * A `filled` outline becomes a solid region. The editor Y flip and the X
 * mirror each reverse winding, and a freehand loop can cross itself, so the
 * raw rings are normalised through a NonZero union: any winding fills, the
 * result is outer-positive, and self-overlaps collapse. If Clipper throws,
 * fall back to forcing each ring positive.
 */
function solidRegions(rings) {
  try {
    const merged = booleanUnion(rings, [])
    if (merged?.length) return merged
  } catch (err) {
    console.error('[vectorStroke] filled region union failed:', err)
  }
  return rings.map((ring) => (signedArea(ring) < 0 ? ring.slice().reverse() : ring))
}

function mapPoint(point, fit, mirror) {
  let x = (point.x - fit.cx) * fit.sx
  let y = (point.y - fit.cy) * fit.sy
  if (mirror) x = -x
  return { x, y }
}

/**
 * `drawings` are centerlines in the same pre-fit space as `rawPaths`
 * (tracer pixels, Y up). `fittedPaths` is that silhouette after
 * `fitInnerCavityPaths` (including the X mirror). `fit` is the pre-mirror
 * measure. `mirror` applies the same X flip the cavity just received.
 *
 * `options.replaceBase` means the editor owns the silhouette: the traced
 * loops were edited and arrive as `baked` drawings, so `fittedPaths` is
 * dropped instead of unioned. The fit still comes from the original trace,
 * which pins the millimetre scale, so erasing a corner cannot re-normalise
 * the cavity back up to the requested width and height (Rule 6).
 */
export function unionDrawingStrokes(fittedPaths, drawings, fit, mirror, options = null) {
  const replaceBase = Boolean(options?.replaceBase)
  const base = replaceBase ? [] : (fittedPaths || []).filter((loop) => loop && loop.length >= 3)
  if (!drawings?.length || !fit) return base
  const expanded = []
  const fills = []
  let baked = 0
  for (const stroke of drawings) {
    const points = stroke?.points
    if (!points || points.length < 2) continue
    const mm = []
    for (const p of points) {
      const x = Number(p?.x)
      const y = Number(p?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      mm.push(mapPoint({ x, y }, fit, mirror))
    }
    if (mm.length < 2) continue
    if (stroke.baked) {
      if (mm.length >= 3) {
        expanded.push(mirror ? mm.slice().reverse() : mm)
        baked += 1
      }
      continue
    }
    if (stroke.lineStyle === 'filled' && mm.length >= 3) {
      // The outline itself is the boundary: no stroke band is added.
      fills.push(mm)
      continue
    }
    if (stroke.lineStyle === 'dashed') {
      const cuts = dashCutSegments(mm, Boolean(stroke.closed), DASH_CUT_MM, DASH_GAP_MM)
      for (const segment of cuts) {
        expanded.push(...expandStrokeToPolygons(segment, false, stroke.strokeWidth))
      }
      continue
    }
    expanded.push(...expandStrokeToPolygons(mm, Boolean(stroke.closed), stroke.strokeWidth))
  }
  if (fills.length) expanded.push(...solidRegions(fills))
  if (!expanded.length) return base
  if (!base.length) {
    // An edited silhouette with nothing layered on it is returned vertex for
    // vertex. Once strokes or fills overlap it they must be merged, or the
    // cutter would receive crossing loops instead of one outline.
    if (!replaceBase || expanded.length === baked) return expanded
    try {
      const merged = booleanUnion(expanded, [])
      return merged?.length ? merged : expanded
    } catch (err) {
      console.error('[vectorStroke] edited cavity union failed:', err)
      return expanded
    }
  }
  try {
    const merged = booleanUnion(base, expanded)
    return merged?.length ? merged : base
  } catch (err) {
    console.error('[vectorStroke] drawing union failed:', err)
    return base
  }
}

/** Cutter path: fit already happened. Stroke width is absolute millimetres. */
export function unionDrawingsOntoFittedCavity(rawPaths, fittedPaths, drawings, settings, replaceBase = false) {
  if (!rawPaths?.length) return fittedPaths || []
  if (!replaceBase && !drawings?.length) return fittedPaths || []
  const fit = measureFit(rawPaths, settings?.width, settings?.height, settings?.aspectLocked)
  if (!fit) return fittedPaths || []
  const mirror = settings?.mirrorDesign !== false
  return unionDrawingStrokes(fittedPaths, drawings, fit, mirror, { replaceBase })
}
