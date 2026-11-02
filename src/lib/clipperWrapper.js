import {
  ClipType,
  EndType,
  FillRule,
  JoinType,
  PolyTree64,
  booleanOpWithPolyTree,
  difference,
  inflatePaths,
  intersect,
  stripDuplicates,
  union,
} from 'clipper2-ts'
import * as THREE from 'three'

const SCALE = 10000

export function toClipperPath(points, scale = SCALE) {
  return points.map((p) => ({
    x: Math.round(p.x * scale),
    y: Math.round(p.y * scale),
  }))
}

export function fromClipperPath(clipperPath, scale = SCALE) {
  return clipperPath.map((pt) => ({
    x: pt.x / scale,
    y: pt.y / scale,
  }))
}

export function toClipperPaths(polygons, scale = SCALE) {
  return polygons.map((poly) => toClipperPath(poly, scale))
}

export function fromClipperPaths(clipperPaths, scale = SCALE) {
  return clipperPaths.map((cp) => fromClipperPath(cp, scale))
}

export function getJoinType(type) {
  switch (type) {
    case 'square':
      return JoinType.Square
    case 'miter':
      return JoinType.Miter
    case 'round':
    default:
      return JoinType.Round
  }
}

export function getEndType(type) {
  switch (type) {
    case 'openSquare':
      return EndType.Square
    case 'openRound':
      return EndType.Round
    case 'openButt':
      return EndType.Butt
    case 'closedLine':
      return EndType.Joined
    case 'closedPolygon':
    default:
      return EndType.Polygon
  }
}

/**
 * Offsets a set of closed 2D polygon paths by delta (in mm).
 * Positive delta expands outward; negative delta contracts inward.
 *
 * Outward offsets always use Clipper2 `JoinType.Round` — a miter/square
 * outward offset is what produced the sharp, uncomfortable printed
 * corners on the blade and handle. Closed cutter walls always use
 * `EndType.Polygon`. Inward offsets honor `joinType` so a cutting cavity
 * can stay true to a traced edge.
 *
 * `options.forceJoin` bypasses that outward-round default entirely when a
 * caller genuinely needs a non-round outward join (miter/square). The
 * cutter-wall stroke in `sanitizeCutterWall` is a single outward round
 * offset, so the default already does the right thing.
 *
 * Clipper2's offsetter natively resolves join intersections, which is
 * what stops the outward spikes Clipper1 (`clipper-lib`) left on tight
 * `jtRound` blade offsets.
 */
export function offsetPolygons(paths, deltaMm, options = {}) {
  const {
    joinType = 'round',
    miterLimit = 2.0,
    endType = 'closedPolygon',
    scale = SCALE,
    // Max deviation (mm) when Clipper2 approximates round joins with arc
    // segments. 0.01mm is still far finer than FDM can print, and with
    // Clipper2's offsetter it does not explode vertex count the way the
    // old Clipper1 tiny-arc default did.
    arcTolerance = 0.01,
  } = options

  if (!paths || paths.length === 0 || Math.abs(deltaMm) < 0.0001) {
    return paths.map((p) => p.map((pt) => ({ x: pt.x, y: pt.y })))
  }

  const resolvedJoin = options.forceJoin ? options.forceJoin : deltaMm > 0 ? 'round' : joinType
  const clipperPaths = toClipperPaths(paths, scale)
  const solution = inflatePaths(
    clipperPaths,
    deltaMm * scale,
    getJoinType(resolvedJoin),
    getEndType(endType),
    miterLimit,
    arcTolerance * scale,
  )

  return fromClipperPaths(solution, scale)
}

/**
 * Boolean Union between Subject and Clip paths
 */
export function booleanUnion(subject, clip, scale = SCALE) {
  const subjPaths = toClipperPaths(subject, scale)
  const clipPaths = clip && clip.length > 0 ? toClipperPaths(clip, scale) : null
  const solution = clipPaths
    ? union(subjPaths, clipPaths, FillRule.NonZero)
    : union(subjPaths, FillRule.NonZero)
  return fromClipperPaths(solution, scale)
}

/**
 * Boolean Difference: Subject minus Clip paths
 */
export function booleanDifference(subject, clip, scale = SCALE) {
  const subjPaths = toClipperPaths(subject, scale)
  const clipPaths = toClipperPaths(clip, scale)
  const solution = difference(subjPaths, clipPaths, FillRule.NonZero)
  return fromClipperPaths(solution, scale)
}

/**
 * Boolean Intersection
 */
export function booleanIntersection(subject, clip, scale = SCALE) {
  const subjPaths = toClipperPaths(subject, scale)
  const clipPaths = toClipperPaths(clip, scale)
  const solution = intersect(subjPaths, clipPaths, FillRule.NonZero)
  return fromClipperPaths(solution, scale)
}



/** Unsigned polygon area (shoelace formula) — used by `splitOuterAndHoles`
 * below to pick the outermost loop purely by enclosed area, independent
 * of winding direction. Raster traces and SVG imports both normalize to
 * outer-positive / hole-negative (`vectorizer.js` / `svgParser.js`), but
 * area magnitude is still the right outer-pick metric if a path arrives
 * with mixed winding. */
export function polygonAreaAbs(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area / 2)
}

/** Even-odd point-in-polygon test — used only by `splitOuterAndHoles`
 * below to measure each loop's CONTAINMENT depth (how many other loops
 * geometrically enclose it), the same style of check `cutterGeometry.js`'s
 * `buildRawRingCap` already uses to pair a hole with its host shape. */
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

/**
 * Splits a FLAT list of closed 2D loops — exactly the shape
 * `traceImageSource`/`parseSvgToPaths` hand back: one outer silhouette,
 * plus zero or more holes and/or disconnected interior detail blobs, all
 * at the same array depth — into the single outermost boundary loop and
 * every other loop.
 *
 * "Outermost" is NOT picked by enclosed area alone anymore. Area magnitude
 * used to be the sole heuristic (the true outer silhouette usually IS the
 * biggest shoelace area in the set — the same assumption `textOnPath.js`'s
 * `pickOuterPath` still relies on for the simpler "one outer + true holes
 * only" wall-text case), but a flat trace list also contains loops that
 * can rival or beat the real outer boundary's area without being it: the
 * large enclosed BACKGROUND ring a single hand-drawn outline stroke always
 * leaves behind (see `vectorizer.js`'s module doc comment), or a stray
 * secondary blob. Picking one of those instead of the true silhouette is
 * exactly what made a complex line-art trace collapse to a near-bounding-
 * box plate. So the outer candidate is now first filtered to loops with
 * containment depth zero — i.e. no OTHER loop in the set encloses it,
 * tested via `pointInPolygon` against each loop's own first vertex — and
 * only THEN is the largest-area survivor picked. A real hole (nested
 * inside the outer boundary) always has depth >= 1 and is disqualified
 * outright, no matter how large its area is.
 *
 * `holes` is deliberately left as a flat list rather than resolved into a
 * strict parent/child tree here — feeding it straight into a nonzero-fill
 * Clipper pass alongside `outer` reconstructs arbitrarily deep real
 * nesting (e.g. a drawn eye that's itself a ring with its own hollow
 * pupil, sitting inside the head silhouette) without this function
 * needing to walk a PolyTree by hand.
 */
export function splitOuterAndHoles(paths) {
  if (!paths || paths.length === 0) return { outer: [], holes: [] }
  if (paths.length === 1) return { outer: [paths[0].map((p) => ({ x: p.x, y: p.y }))], holes: [] }

  const areas = paths.map((p) => polygonAreaAbs(p))

  const pickLargest = (candidateIdxs) => {
    let bestIdx = -1
    let bestArea = -Infinity
    for (const i of candidateIdxs) {
      if (areas[i] > bestArea) {
        bestArea = areas[i]
        bestIdx = i
      }
    }
    return bestIdx
  }

  const topLevelIdxs = []
  for (let i = 0; i < paths.length; i++) {
    const probe = paths[i][0]
    let containedByAnother = false
    for (let j = 0; j < paths.length; j++) {
      if (j === i) continue
      if (pointInPolygon(probe, paths[j])) {
        containedByAnother = true
        break
      }
    }
    if (!containedByAnother) topLevelIdxs.push(i)
  }

  // Defensive fallback for degenerate/self-intersecting trace input where
  // the point-in-polygon probe can't find ANY uncontained loop (should
  // never happen for well-formed closed traces): revert to the old
  // pure-area heuristic rather than producing an empty plate.
  const outerIdx =
    topLevelIdxs.length > 0 ? pickLargest(topLevelIdxs) : pickLargest(paths.map((_, i) => i))

  const outer = [paths[outerIdx].map((p) => ({ x: p.x, y: p.y }))]
  const holes = paths
    .filter((_, i) => i !== outerIdx)
    .map((loop) => loop.map((p) => ({ x: p.x, y: p.y })))
  return { outer, holes }
}

/**
 * The bluntest, most unambiguous possible "keep exactly one loop" filter:
 * given a flat list of loops that SHOULD already be simple/non-self-
 * intersecting (i.e. already passed through `simplifyPolygonPaths`'s
 * `SimplifyPolygons`), keep strictly the single one with the largest
 * absolute (shoelace) area and discard every other loop outright — no
 * containment-depth reasoning, no "is this a hole" logic.
 *
 * Deliberately simpler than `splitOuterAndHoles`: that function's
 * containment-depth-first heuristic exists to correctly reject a large
 * enclosed BACKGROUND ring a raw trace can leave around the real outer
 * silhouette (see its own doc comment) — the right call for a genuinely
 * unprocessed, multi-loop trace where "hole vs. outer" is still an open
 * question. This function is for the OPPOSITE situation: a loop set that
 * is the mechanical byproduct of offsetting a single, already-known-good
 * outer boundary (a clearance/thickness `ClipperOffset` call), where by
 * construction there is no legitimate hole to protect — every extra loop
 * still present is pinch-off debris from a notch narrower than the
 * offset, full stop. Using containment-depth there is not just
 * unnecessary, it's a liability: a self-intersecting or barely-valid
 * offset artifact can trick the depth probe (a single point-in-polygon
 * test against a degenerate loop) into misjudging which loop is
 * "top-level," which is exactly how a tiny sliver can survive
 * `splitOuterAndHoles` instead of being discarded. Pure area comparison
 * has no such failure mode: the true cavity/envelope is, by a wide
 * margin, always the single largest-area survivor.
 */
export function keepLargestLoopByArea(paths) {
  if (!paths || paths.length === 0) return []
  if (paths.length === 1) return [paths[0].map((p) => ({ x: p.x, y: p.y }))]

  let bestIdx = 0
  let bestArea = -Infinity
  for (let i = 0; i < paths.length; i++) {
    const area = polygonAreaAbs(paths[i])
    if (area > bestArea) {
      bestArea = area
      bestIdx = i
    }
  }
  return [paths[bestIdx].map((p) => ({ x: p.x, y: p.y }))]
}

/**
 * Phase 1 ("Cutter" mode) + Phase 2 ("Stamp" mode) helper — collapses a
 * FLAT list of traced loops (outer silhouette, stroke inners, eyes, bows,
 * genuine design holes — all at the same array depth, exactly what
 * `traceImageSource`/`parseSvgToPaths` hand back) into a single
 * "shrink-wrap" envelope: the one outermost boundary loop, with every
 * nested/interior loop dropped — exactly as if the line-art had been
 * filled solid black and only its outer silhouette traced back out.
 *
 * PURE EXTRACTION ONLY: this function does NOT offset, melt, or decimate
 * the boundary it returns. Crossing and overlapping contours are resolved
 * by a Clipper NonZero union, and those vertices are returned as-is — no
 * `simplifyPolygonPaths`, `robustSimplifyPaths`, or RDP. The single
 * outermost loop is then selected with `splitOuterAndHoles`. That purity
 * matters because this same function backs BOTH the solid "Stamp" base
 * plate (`buildStampGeometry`) and the cutter cavity. Stamp-plate cleanup
 * is the caller's job. Any offset baked in here would silently inflate
 * the Stamp's plate, so the cutter's outward stroke lives only in
 * `sanitizeCutterWall` — that dedicated function isolates via this one
 * first, then applies a single round outward offset and never erodes it
 * back.
 */
export function isolateOuterContour(paths) {
  if (!paths || paths.length === 0) return []
  const valid = paths.filter((loop) => loop && loop.length >= 3)
  if (valid.length === 0) return []
  // Resolve crossings into a solid envelope. Do not clean or decimate:
  // the cutter cavity must stay 1:1 with this union (Rule 1).
  const envelope = booleanUnion(valid, null)
  if (!envelope || envelope.length === 0) return []
  const finalOuter = splitOuterAndHoles(envelope).outer
  return finalOuter && finalOuter.length > 0 ? finalOuter : []
}

/** Outward offset (mm) applied to the outer silhouette to form the cutter
 * cavity. `JoinType.Round` rounds convex tips for the printer nozzle while leaving
 * concave inlets (V-notches, ribbons) as sharp intersections of the offset
 * edges. Not a morphological close: this path is NEVER eroded back. */
const CUTTER_WALL_STROKE_MM = 1.5

/**
 * Phase 1 ("Cutter" mode) ONLY — Cookiecad-style outline offset:
 * isolate the outermost silhouette, apply one outward `JoinType.Round`
 * offset, then clean vertices. Inner concavities stay sharp; only
 * outer tips are rounded. No rubber-band, no inlet bridging, no Laplacian/Chaikin.
 *
 * Pipeline (and nothing else):
 *  1. `isolateOuterContour` — drop holes / interior stroke loops.
 *  2. Single outward offset by `meltRadius` (`JoinType.Round` + `EndType.Polygon`).
 *  3. `robustSimplifyPaths` — drop collinear/float-noise vertices.
 *  4. `keepLargestLoopByArea` — drop pinch-off debris; keep one loop.
 *
 * DELIBERATELY NOT shared with `isolateOuterContour` / `buildStampGeometry`.
 * The stamp imprint stays 1:1 with the raw `basePaths`.
 */
export function sanitizeCutterWall(paths, meltRadius = CUTTER_WALL_STROKE_MM) {
  if (!paths || paths.length === 0) return []

  // 1. ISOLATE FIRST: Keep only the outermost silhouette to prevent internal
  // holes from inflating into the wall.
  const outerOnly = isolateOuterContour(paths)
  if (!outerOnly || outerOnly.length === 0) return []

  // 0.01mm is fine enough for 3D printing without exploding the vertex count.
  const arcTolerance = 0.01
  const offsetOpts = { joinType: 'round', endType: 'closedPolygon', arcTolerance }

  // 2. DIRECT OFFSET: Instead of a destructive shrink-wrap, simply offset
  // the contour outward. Round join keeps outer corners print-smooth while
  // inner concavities intersect cleanly and remain sharp.
  let envelope = offsetPolygons(outerOnly, meltRadius, offsetOpts)
  if (!envelope || envelope.length === 0) return outerOnly

  // 3. ROBUST CLEANUP: Clean collinear points and float noise before the
  // manifold-3d extrude, without altering the actual shape.
  envelope = robustSimplifyPaths(envelope, 0.05)
  if (!envelope || envelope.length === 0) return outerOnly

  // 4. PREVENT SLIVERS: Keep strictly the largest loop to eliminate any
  // tiny disconnected artifact loops from offsetting sharp corners.
  envelope = keepLargestLoopByArea(envelope)

  return envelope && envelope.length > 0 ? envelope : outerOnly
}

/**
 * Simplifies and removes self-intersections from paths.
 *
 * `cleanDistanceMm` controls `CleanPolygons`' duplicate/near-duplicate
 * vertex removal, in real-world mm — NOT Clipper's internal scaled
 * integer units. The default (0.0001mm) only ever removes true, exact
 * float-noise duplicates (e.g. the seam vertex `ClipperOffset` can leave
 * behind). Callers feeding a shape into vertex-by-vertex geometry math
 * that divides by each edge's own length (`buildRoundJoinFrame` in
 * cutterGeometry.js) or into ear-clipping triangulation
 * (`THREE.ExtrudeGeometry`) need a much coarser real tolerance (e.g.
 * 0.01mm — still 10x finer than any FDM printer can resolve): a raw
 * trace or offset arc can leave consecutive points a fraction of a mm
 * apart that are non-zero-length but still too short for that downstream
 * math to stay numerically stable, producing wrong-direction normals
 * (visible seams on a lofted wall) or degenerate near-zero-area
 * triangles (faceted/shadowed shading on a flat extruded face).
 */
export function simplifyPolygonPaths(paths, cleanDistanceMm = 0.0001, scale = SCALE) {
  if (!paths || paths.length === 0) return []
  const clipperPaths = toClipperPaths(paths, scale)
    .map((loop) => stripDuplicates(loop, true))
    .filter((loop) => loop.length >= 3)
  if (clipperPaths.length === 0) return []

  // Clipper2: a NonZero union of the subject against itself is the
  // replacement for Clipper1 `SimplifyPolygons` — it resolves
  // self-intersections and overlapping contours into a valid PolyTree.
  const simplified = union(clipperPaths, FillRule.NonZero)
  const minDist = Math.max(cleanDistanceMm * scale, 0)
  if (minDist <= 1) return fromClipperPaths(simplified, scale)

  // Distance-based duplicate strip: drop any vertex closer than the
  // caller's real-world tolerance to the previous kept vertex.
  const minDistSq = minDist * minDist
  const cleaned = simplified.map((loop) => {
    if (loop.length < 3) return loop
    const out = [loop[0]]
    for (let i = 1; i < loop.length; i++) {
      const prev = out[out.length - 1]
      const dx = loop[i].x - prev.x
      const dy = loop[i].y - prev.y
      if (dx * dx + dy * dy >= minDistSq) out.push(loop[i])
    }
    if (out.length > 3) {
      const a = out[0]
      const b = out[out.length - 1]
      const dx = a.x - b.x
      const dy = a.y - b.y
      if (dx * dx + dy * dy < minDistSq) out.pop()
    }
    return out.length >= 3 ? out : loop
  })
  return fromClipperPaths(cleaned, scale)
}

/** Squared perpendicular distance from `pt` to the infinite line through
 * `a`/`b` (or, if `a`===`b` within float precision, straight point-to-point
 * distance — the correct degenerate case for a zero-length chord). Squared
 * to avoid a `Math.sqrt` per point in the RDP scan below; every caller only
 * ever compares it against another squared distance. */
function perpendicularDistanceSq(pt, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-20) {
    const ex = pt.x - a.x
    const ey = pt.y - a.y
    return ex * ex + ey * ey
  }
  const t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq
  const px = a.x + t * dx
  const py = a.y + t * dy
  const ex = pt.x - px
  const ey = pt.y - py
  return ex * ex + ey * ey
}

/** Ramer–Douglas–Peucker simplification of an OPEN polyline: `points[0]`
 * and `points[points.length - 1]` are always kept; every interior point is
 * dropped unless some sub-run needs it to stay within `epsilonSq` of the
 * chord approximating that run. Iterative (explicit stack) rather than
 * recursive so a several-thousand-point raw trace can't blow the call
 * stack. */
function rdpSimplifyOpenChain(points, epsilonSq) {
  const n = points.length
  if (n < 3) return points.slice()

  const keep = new Array(n).fill(false)
  keep[0] = true
  keep[n - 1] = true
  const stack = [[0, n - 1]]

  while (stack.length > 0) {
    const [s, e] = stack.pop()
    if (e <= s + 1) continue
    const a = points[s]
    const b = points[e]
    let maxDistSq = -1
    let maxIdx = -1
    for (let i = s + 1; i < e; i++) {
      const distSq = perpendicularDistanceSq(points[i], a, b)
      if (distSq > maxDistSq) {
        maxDistSq = distSq
        maxIdx = i
      }
    }
    if (maxDistSq > epsilonSq) {
      keep[maxIdx] = true
      stack.push([s, maxIdx])
      stack.push([maxIdx, e])
    }
  }

  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

/**
 * Ramer–Douglas–Peucker simplification of one CLOSED loop. Standard RDP
 * needs two fixed endpoints to anchor its chord tests; a closed loop has
 * none, so this first picks an anchor pair — point 0 and whichever other
 * point is farthest from it (an O(n) heuristic, not the true O(n²) diameter
 * pair, but more than sufficient to split the loop into two well-separated
 * chains) — splits the loop into those two open chains, RDP-simplifies each
 * independently (with its two anchors held fixed), then stitches them back
 * together.
 *
 * This is the piece `CleanPolygons` (see `simplifyPolygonPaths` above)
 * structurally cannot do: `CleanPolygons` only ever judges a vertex by its
 * distance to its IMMEDIATE neighbors, so a long run of many nearly-
 * collinear points — the "staircase" a raster/marching-squares trace
 * leaves along a diagonal or gentle curve, where each individual
 * point-to-point gap is well above any duplicate-removal threshold even
 * though the whole run adds zero real shape information — survives
 * `CleanPolygons` untouched. That density is exactly what turns into
 * near-zero-area sliver triangles under `THREE.ExtrudeGeometry`'s
 * ear-clipping triangulator (the Stamp base-plate shading defect) and
 * near-zero-length edges under `buildRoundJoinFrame`'s manual per-vertex
 * tangent math (`cutterGeometry.js`) — a perpendicular-DISTANCE test, not
 * a point-to-point one, is what's needed to catch it.
 */
function simplifyClosedLoopRDP(loopPoints, epsilonMm) {
  const n = loopPoints.length
  if (n < 5 || !(epsilonMm > 0)) return loopPoints

  let farIdx = 0
  let farDistSq = -1
  const p0 = loopPoints[0]
  for (let i = 1; i < n; i++) {
    const dx = loopPoints[i].x - p0.x
    const dy = loopPoints[i].y - p0.y
    const distSq = dx * dx + dy * dy
    if (distSq > farDistSq) {
      farDistSq = distSq
      farIdx = i
    }
  }
  // Every point coincident with point 0 — nothing left to simplify.
  if (farIdx === 0) return loopPoints

  const epsilonSq = epsilonMm * epsilonMm
  const chainA = loopPoints.slice(0, farIdx + 1) // p0 .. pFar
  const chainB = loopPoints.slice(farIdx).concat([loopPoints[0]]) // pFar .. end .. p0 (wraps)

  const simplifiedA = rdpSimplifyOpenChain(chainA, epsilonSq)
  const simplifiedB = rdpSimplifyOpenChain(chainB, epsilonSq)

  // Drop chainB's first/last points — pFar and p0 — since they're already
  // present as chainA's last/first, or every simplified loop would carry a
  // duplicated vertex at both seams.
  const merged = simplifiedA.concat(simplifiedB.slice(1, -1))
  return merged.length >= 3 ? merged : loopPoints
}

/**
 * Applies `simplifyClosedLoopRDP` to every loop in a flat path list.
 * `epsilonMm` is a real-world perpendicular-deviation tolerance — how far
 * a dropped point is allowed to have been from the straight chord that
 * replaces its run — not a point-to-point distance, so it's meaningful
 * even for widely-spaced raster-trace points a plain duplicate-distance
 * pass like `CleanPolygons` would never touch.
 */
export function simplifyPathsRDP(paths, epsilonMm) {
  if (!paths || paths.length === 0) return paths
  return paths.map((loop) => simplifyClosedLoopRDP(loop, epsilonMm))
}

/**
 * The complete "make this safe for downstream lofting/triangulation" pass:
 * Clipper's own `CleanPolygons`/`SimplifyPolygons` (via `simplifyPolygonPaths`)
 * resolves self-intersections and strips near-duplicate vertices, THEN
 * `simplifyPathsRDP` thins the remaining nearly-collinear runs Clipper's
 * neighbor-distance test can't see (see its doc comment above) — in that
 * order, since RDP's chord test is only meaningful on an already
 * self-intersection-free polygon. Use this (not a bare `simplifyPolygonPaths`
 * call) at every site feeding `buildRoundJoinFrame`/`buildVerticalWall`'s
 * per-vertex tangent math or `pathsToThreeShapes`/`ExtrudeGeometry`'s
 * triangulation in `cutterGeometry.js`.
 */
export function robustSimplifyPaths(paths, toleranceMm) {
  const cleaned = simplifyPolygonPaths(paths, toleranceMm)
  return simplifyPathsRDP(cleaned, toleranceMm)
}

export { computePathBounds, computePathsBounds, fitPathsToSize } from './pathMetrics.js'

/**
 * Converts a set of 2D polygon paths (outer + holes) into THREE.Shape[] with holes
 */
export function pathsToThreeShapes(paths, scale = SCALE) {
  if (!paths || paths.length === 0) return []

  const clipperPaths = toClipperPaths(paths, scale)
  const polyTree = new PolyTree64()
  booleanOpWithPolyTree(ClipType.Union, clipperPaths, null, polyTree, FillRule.NonZero)

  const shapes = []

  function addNodeToShapes(node) {
    const contour = node.polygon ? fromClipperPath(node.polygon, scale) : []
    if (contour.length < 3) {
      for (let i = 0; i < node.count; i++) addNodeToShapes(node.child(i))
      return
    }

    if (!node.isHole) {
      const shape = new THREE.Shape()
      shape.moveTo(contour[0].x, contour[0].y)
      for (let i = 1; i < contour.length; i++) {
        shape.lineTo(contour[i].x, contour[i].y)
      }
      shape.closePath()

      for (let i = 0; i < node.count; i++) {
        const childNode = node.child(i)
        if (childNode.isHole && childNode.polygon && childNode.polygon.length >= 3) {
          const holeContour = fromClipperPath(childNode.polygon, scale)
          const holePath = new THREE.Path()
          holePath.moveTo(holeContour[0].x, holeContour[0].y)
          for (let j = 1; j < holeContour.length; j++) {
            holePath.lineTo(holeContour[j].x, holeContour[j].y)
          }
          holePath.closePath()
          shape.holes.push(holePath)

          for (let k = 0; k < childNode.count; k++) {
            addNodeToShapes(childNode.child(k))
          }
        }
      }
      shapes.push(shape)
    }
  }

  for (let i = 0; i < polyTree.count; i++) {
    addNodeToShapes(polyTree.child(i))
  }

  return shapes
}
