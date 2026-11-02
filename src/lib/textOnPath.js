import * as THREE from 'three'
import { extrudePaths } from './manifoldEngine.js'

/**
 * Helpers for building true, volumetric 3D text that wraps around an
 * arbitrary closed 2D polygon path (the cutter's outer wall silhouette)
 * and embosses outward from it. Glyphs are extruded with manifold-3d
 * (watertight, holes preserved), then bent around the curve.
 */

/** Per-curve samples for `Shape.getPoints`. Lines stay at 1 sample. */
const GLYPH_CURVE_DIVISIONS = 24

/**
 * Closed `{x, y}` loop from a Three.js contour. Drops consecutive
 * duplicates (and a repeated closing vertex) so CrossSection does not
 * see a zero-length edge. Null when fewer than 3 distinct points remain.
 */
function loopFromPoints(points) {
  const loop = []
  for (const p of points) {
    const x = p.x
    const y = p.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const prev = loop[loop.length - 1]
    if (prev && Math.hypot(x - prev.x, y - prev.y) < 1e-6) continue
    loop.push({ x, y })
  }
  if (loop.length > 1) {
    const a = loop[0]
    const b = loop[loop.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) loop.pop()
  }
  return loop.length >= 3 ? loop : null
}

/**
 * Engine winding: outers positive (CCW), holes negative (CW). Manifold
 * `NonZero` fill then punches counters (`O`, `A`, `B`) instead of
 * solidifying them. Reverses in place when the font contour disagrees.
 */
function orientLoop(points, isOuter) {
  const loop = loopFromPoints(points)
  if (!loop) return null
  const positive = polygonSignedArea(loop) > 0
  if (positive !== isOuter) loop.reverse()
  if (Math.abs(polygonSignedArea(loop)) < 1e-8) return null
  return loop
}

/**
 * 2D glyph outlines for one string. Each outer is immediately followed
 * by its holes so a single `extrudePaths` call fills letters and keeps
 * counters. `letterSpacing` / `lineHeight` match the old TextGeometry
 * layout (three-stdlib `Font.generateShapes` honors both).
 */
function glyphLoopsFromFont(font, text, fontSize, divisions, letterSpacing, lineHeight) {
  const shapes = font.generateShapes(text, fontSize, { letterSpacing, lineHeight })
  const paths = []
  for (const shape of shapes) {
    const outer = orientLoop(shape.getPoints(divisions), true)
    if (!outer) continue
    paths.push(outer)
    for (const hole of shape.holes || []) {
      const inner = orientLoop(hole.getPoints(divisions), false)
      if (inner) paths.push(inner)
    }
  }
  return paths
}

export function polygonSignedArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

/** Picks the path with the largest enclosed area — the outer silhouette. */
export function pickOuterPath(paths) {
  if (!paths || paths.length === 0) return null
  let best = paths[0]
  let bestArea = Math.abs(polygonSignedArea(best))
  for (const p of paths) {
    const a = Math.abs(polygonSignedArea(p))
    if (a > bestArea) {
      best = p
      bestArea = a
    }
  }
  return best && best.length >= 3 ? best : null
}

export function cumulativeLengths(points) {
  const lens = [0]
  for (let i = 1; i <= points.length; i++) {
    const a = points[i - 1]
    const b = points[i % points.length]
    lens.push(lens[i - 1] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  return lens
}

/** Samples position + forward tangent on a closed polygon at arc-length `s`. */
export function sampleAtArcLength(points, lens, s) {
  const total = lens[lens.length - 1]
  if (total <= 0) return { x: points[0].x, y: points[0].y, tangent: { x: 1, y: 0 } }

  let d = s % total
  if (d < 0) d += total

  let lo = 0
  let hi = lens.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (lens[mid] <= d) lo = mid
    else hi = mid
  }

  const segStart = lens[lo]
  const segLen = lens[lo + 1] - segStart || 1e-6
  const t = (d - segStart) / segLen
  const a = points[lo % points.length]
  const b = points[(lo + 1) % points.length]
  const x = a.x + (b.x - a.x) * t
  const y = a.y + (b.y - a.y) * t

  const tangent = { x: b.x - a.x, y: b.y - a.y }
  const tlen = Math.hypot(tangent.x, tangent.y) || 1
  tangent.x /= tlen
  tangent.y /= tlen

  return { x, y, tangent }
}

/**
 * A simple closed polygon's winding direction fully determines which way
 * "rotate the tangent 90°" points outward, everywhere along the curve —
 * unlike a per-point centroid-distance test (used previously), which can
 * flip the wrong way in concave regions (e.g. a heart's top cleft) and
 * turn the text inside-out mid-string. Computing the sign once from the
 * signed area and reusing it for every sample is both cheaper and correct.
 */
export function pathOrientationSign(points) {
  return polygonSignedArea(points) >= 0 ? 1 : -1
}

/**
 * Builds one watertight text solid, bent around `outerPath` and embossed
 * outward from it.
 *
 * The flat solid comes from `extrudePaths` (manifold-3d), not Three.js
 * `TextGeometry` / `ExtrudeGeometry`. Local axes of that solid match the
 * old extrusion, so the perimeter bend is unchanged:
 *
 *  - Local X (position along the text baseline) maps to arc length on the
 *    path, so the glyphs follow the curve.
 *  - Local Y (glyph height / multi-line stacking) maps to world Z, so the
 *    text stands upright on the vertical wall.
 *  - Local Z (extrusion, 0..depth) maps to the path's outward normal, so
 *    the text protrudes by `extrusionDepth`.
 *
 * The bend is a continuous remap of an already-manifold triangle mesh
 * (same connectivity). It is not a taper: blade/handle tapers stay stacked
 * prisms. Normals are recomputed after the remap.
 */
export function buildWallTextGeometry(
  outerPath,
  text,
  font,
  {
    fontSize = 6,
    extrusionDepth = 0.6,
    startFraction = 0,
    lineDistance = 1.5,
    letterSpacing = 0,
    curveSegments = GLYPH_CURVE_DIVISIONS,
    z = 0,
    // Extra depth generated BEHIND the wall's original surface (into the
    // solid material) in addition to `extrusionDepth`'s visible protrusion
    // in front of it. A flush/tangent emboss (embedDepth = 0) only ever
    // TOUCHES the wall along one coincident face — which is exactly what
    // caused the z-fighting glitching seen on screen and the broken,
    // self-intersecting STL export. Giving the text genuine volumetric
    // overlap with the wall is what lets `cutterGeometry.js`'s CSG boolean
    // union resolve a single, clean, watertight combined surface instead.
    embedDepth = 0,
  } = {},
) {
  if (!outerPath || outerPath.length < 3 || !text || !text.trim() || !font) return null

  const lens = cumulativeLengths(outerPath)
  const total = lens[lens.length - 1]
  if (total <= 0) return null

  const orientation = pathOrientationSign(outerPath)
  const visibleDepth = Math.max(extrusionDepth, 0.05)
  const embed = Math.max(embedDepth, 0)
  // Extrude the visible protrusion PLUS the embed, from z = 0. The bend
  // subtracts `embed` from local Z so the solid straddles the wall:
  // [-embed, visibleDepth]. Extruding only `extrusionDepth` would shrink
  // the visible emboss by the overlap.
  const depth = visibleDepth + embed
  const divisions = Math.max(1, Math.round(curveSegments) || GLYPH_CURVE_DIVISIONS)

  let paths
  try {
    paths = glyphLoopsFromFont(
      font,
      text,
      Math.max(fontSize, 0.4),
      divisions,
      letterSpacing,
      lineDistance,
    )
  } catch (err) {
    console.error('[textOnPath] glyph outline extraction failed:', err)
    return null
  }
  if (paths.length === 0) return null

  const textGeo = extrudePaths(paths, depth, { z0: 0 })
  if (!textGeo?.attributes?.position) return null

  textGeo.computeBoundingBox()
  const bbox = textGeo.boundingBox
  if (!bbox || !isFinite(bbox.max.x)) {
    textGeo.dispose()
    return null
  }
  const centerY = (bbox.max.y + bbox.min.y) / 2
  const startS = startFraction * total

  const posAttr = textGeo.attributes.position
  const count = posAttr.count
  const bent = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    const lx = posAttr.getX(i)
    const ly = posAttr.getY(i) - centerY
    // Re-zero so lz=0 lands exactly on the wall's original surface: the
    // embedded portion becomes negative (sinks into the solid), the
    // visible emboss portion stays positive, up to `visibleDepth`.
    const lz = posAttr.getZ(i) - embed

    const s = startS + lx
    const { x, y, tangent } = sampleAtArcLength(outerPath, lens, s)
    const nx = tangent.y * orientation
    const ny = -tangent.x * orientation

    bent[i * 3] = x + nx * lz
    bent[i * 3 + 1] = y + ny * lz
    bent[i * 3 + 2] = z + ly
  }

  textGeo.setAttribute('position', new THREE.BufferAttribute(bent, 3))
  textGeo.deleteAttribute('normal')
  textGeo.computeVertexNormals()
  textGeo.computeBoundingBox()
  textGeo.computeBoundingSphere()

  return textGeo
}
