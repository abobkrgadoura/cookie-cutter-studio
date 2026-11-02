/**
 * Raster to Vector Tracing Engine.
 *
 * Contour extraction is classic Moore-Neighbor tracing over a strictly-
 * thresholded binary grid (8-connected solid / 4-connected background),
 * returning the exact pixel boundary of the largest blob plus its holes.
 *
 * That raw boundary is pixel-dense and stair-stepped by construction —
 * every 1px stair is its own vertex. `cutterGeometry.js` computes wall
 * normals PER VERTEX from each point's two adjacent edge directions (see
 * `buildRoundJoinFrame`), so a dense run of alternating stair-step edges
 * produces a dense run of alternating normals — which, once lofted,
 * reads as vertical striations/faceting on the 3D wall. SVG paths never
 * hit this because they're already low-vertex smooth curves; raster
 * traces need to be simplified down to that same shape of input first.
 *
 * The post-process therefore runs SIMPLIFY-THEN-SMOOTH:
 *   1. Ramer-Douglas-Peucker collapses the raw stair-step trace down to
 *      its essential corners (a closed-loop-safe variant — see
 *      `simplifyClosedLoopRDP`), well under any perceptible silhouette
 *      change (tolerance is sub-2px at trace resolution).
 *   2. The existing short-edge Taubin (size-preserving Laplacian) plus
 *      four Chaikin passes then re-round what RDP left polygonal.
 *      Taubin's edge-length gate is bbox-relative so a circle's O(√r)
 *      raster flats melt, while a square side or star arm (a large
 *      fraction of the silhouette) is pinned. Chaikin is length-agnostic:
 *      every non-sharp run is cut, including long residual chords that
 *      share a sharp corner at one end, so those chords densify instead
 *      of extruding as planar faces. True sharp vertices stay uncut.
 *   3. Edge length alone can't tell a raster curve's short residual chord
 *      apart from a genuinely short-but-sharp feature (a small notch, tab,
 *      or letter corner) — both survive RDP with short adjacent edges. So
 *      every vertex is additionally classified by TURN ANGLE (see
 *      `computeSharpCorners`): anything turning >= `SHARP_CORNER_TURN_DEG`
 *      is a real corner and is pinned by both the Taubin and Chaikin passes
 *      regardless of edge length — only shallow-angle (curve-like) runs
 *      get smoothed. This plays the same role as Potrace's `alphamax`,
 *      just expressed as a direct geometric angle instead of a curve-fit
 *      coefficient.
 *
 * This module has NO DOM dependency beyond 2D canvas drawing, via
     * `OffscreenCanvas` inside the geometry Web Worker.
     */
    
/** Longest side of the raster the tracer actually walks. The 2D vector
 * overlay uses the same size so a drawn point and a traced vertex share
 * one pixel frame. */
export const TRACE_MAX_DIMENSION = 1200

export function traceRasterSize(width, height, maxDimension = TRACE_MAX_DIMENSION) {
  let w = Math.max(1, Math.round(Number(width) || 1))
  let h = Math.max(1, Math.round(Number(height) || 1))
  const cap = Number(maxDimension) > 0 ? Number(maxDimension) : TRACE_MAX_DIMENSION
  if (w > cap || h > cap) {
    const scale = cap / Math.max(w, h)
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
  }
  return { width: w, height: h }
}

    /** Creates a 2D-drawable canvas, preferring OffscreenCanvas (required
 * inside a Web Worker; also supported on the main thread in every
 * evergreen browser). Falls back to a real <canvas> element when neither
 * is available (very old browsers only). */
function createCanvas(w, h) {
      if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(w, h)
      }
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        return canvas
      }
      throw new Error('No canvas implementation available in this context')
    }
    
    /**
     * Traces a drawable image source (`ImageBitmap`, `HTMLImageElement`,
     * `HTMLCanvasElement`, etc.) into the exact pixel-boundary polygons of
     * the thresholded silhouette. Designed to run off the main thread: pass
     * an `ImageBitmap` when calling from a Web Worker.
     */
    export function traceImageSource(img, options = {}) {
      const {
        threshold = 128,
        invert = false,
        // Only downscale truly huge uploads so Moore-Neighbor stays interactive.
        // 400px was throwing away too much of the source silhouette.
        maxDimension = TRACE_MAX_DIMENSION,
      } = options
    
  const sized = traceRasterSize(
    img.naturalWidth || img.width || 300,
    img.naturalHeight || img.height || 300,
    maxDimension,
  )
  const w = sized.width
  const h = sized.height

  const canvas = createCanvas(w, h)
      const ctx = canvas.getContext('2d')
      // No pre-blur: that would shift the thresholded edge away from the
      // uploaded pixels. Draw 1:1 (or uniformly downscaled) then hard-threshold.
      ctx.drawImage(img, 0, 0, w, h)
    
      const imgData = ctx.getImageData(0, 0, w, h)
      const data = imgData.data
    
      const grid = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4
          const alphaFrac = data[idx + 3] / 255
          const r = data[idx] * alphaFrac + 255 * (1 - alphaFrac)
          const g = data[idx + 1] * alphaFrac + 255 * (1 - alphaFrac)
          const b = data[idx + 2] * alphaFrac + 255 * (1 - alphaFrac)
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b
          const isSolid = invert ? luminance > threshold : luminance < threshold
          grid[y * w + x] = isSolid ? 1 : 0
        }
      }
    
      const rawContours = traceGridContours(grid, w, h)
      const destaired = destaircasePixelContours(rawContours)
    
      const paths = []
      for (const contour of destaired) {
        if (!contour || contour.length < 3) continue
        paths.push(contour.map((p) => ({ x: p.x, y: -p.y })))
      }
    
      return { paths, width: w, height: h }
    }
    
    // Backwards-compatible alias (same implementation — any CanvasImageSource
    // works, not just <img> elements).
    export const traceImageElement = traceImageSource
    
    /** Unsigned polygon area (shoelace formula) — used for the resolution-
     * relative noise-area filter in `traceGridContours`. */
    function polygonArea(points) {
      return Math.abs(signedPolygonArea(points))
    }
    
    /** SIGNED polygon area (shoelace formula) — the sign encodes winding
     * direction, which is what `normalizeWinding` uses to guarantee outer
     * loops and hole loops always wind OPPOSITE to each other (the convention
     * the rest of the app's geometry pipeline — `computeMiterNormals` et al —
     * relies on to correctly offset/loft both an outer wall and a "hole" wall,
     * e.g. the inside of a letter "O" or a donut charm). */
    function signedPolygonArea(points) {
      let area = 0
      for (let i = 0; i < points.length; i++) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        area += a.x * b.y - b.x * a.y
      }
      return area / 2
    }
    
    /** Forces `points`' winding to match its role: outer contours end up with
     * POSITIVE signed area, holes with NEGATIVE — reversing the point order in
     * place if the traced winding came out the other way. Moore-Neighbor
     * tracing's natural direction depends on which side of the blob the start
     * pixel's search begins from, so this is what actually GUARANTEES outer
     * and hole loops are consistently opposite, rather than relying on the
     * trace happening to come out right. */
    function normalizeWinding(points, isOuter) {
      const isPositive = signedPolygonArea(points) > 0
      if (isPositive !== isOuter) points.reverse()
      return points
    }
    
    /** Drops vertices that sit on a straight run between their neighbors.
     * Lossless: the polyline's geometry is identical, just without redundant
     * mid-edge samples from walking pixel-by-pixel along an axis-aligned side. */
    function collapseCollinear(points) {
      const stripped = stripDuplicateVertices(points)
      const n = stripped.length
      if (n < 4) return stripped
      const out = []
      for (let i = 0; i < n; i++) {
        const prev = stripped[(i - 1 + n) % n]
        const curr = stripped[i]
        const next = stripped[(i + 1) % n]
        const cross = (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x)
        if (Math.abs(cross) > 1e-6) out.push(curr)
      }
      return out.length >= 3 ? out : stripped
    }
    
    /** Moore tracing can re-push the start pixel as it closes the loop; a
     * zero-length edge makes the next real corner look "collinear" and get
     * dropped. Also drops any accidental consecutive duplicates. */
    function stripDuplicateVertices(points) {
      if (!points || points.length === 0) return points
      const out = []
      for (const p of points) {
        const last = out[out.length - 1]
        if (last && last.x === p.x && last.y === p.y) continue
        out.push(p)
      }
      if (out.length >= 2) {
        const first = out[0]
        const last = out[out.length - 1]
        if (first.x === last.x && first.y === last.y) out.pop()
      }
      return out
    }
    
    /**
     * Anti-aliases the raw pixel outline without moving the macro silhouette.
     *
     * 1. Collapse exact-collinear mid-edge samples (lossless).
     * 2. Average true 1px / 90° stairs onto their implied diagonal.
     * 3. Taubin (λ/μ Laplacian) only at vertices whose both adjacent edges
     *    are shorter than a bbox-relative threshold. A star tip or square
     *    corner has two long edges and is pinned; a circle's raster flats
     *    are O(√r) and get anti-aliased.
     * 4. Chaikin on every non-sharp run (length-agnostic). Sharp vertices
     *    are pinned, but an adjacent long chord is still cut/densified so
     *    the lofted wall has enough columns to shade smoothly.
     */
function destaircasePixelContours(contours) {
  return contours.map((loop) => destaircaseLoop(loop)).filter((p) => p.length >= 3)
}

/** Perpendicular distance from `point` to the infinite line through
 * `lineStart`/`lineEnd` — degenerates to plain point-distance when the two
 * line points coincide (guards the zero-length-chord division). Squared
 * internally so the RDP scan avoids a `Math.sqrt` per candidate. */
function perpendicularDistanceSq(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-9) {
    const ex = point.x - lineStart.x
    const ey = point.y - lineStart.y
    return ex * ex + ey * ey
  }
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq
  const projX = lineStart.x + t * dx
  const projY = lineStart.y + t * dy
  const ex = point.x - projX
  const ey = point.y - projY
  return ex * ex + ey * ey
}

/** Iterative Ramer-Douglas-Peucker over an OPEN polyline — both endpoints
 * are always kept. An explicit stack replaces recursion so a several-
 * thousand-point Moore-Neighbor outline cannot blow the call stack. */
function rdpOpen(points, epsilon) {
  const n = points.length
  if (n < 3) return points.slice()

  const epsilonSq = epsilon * epsilon
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

/** RDP tolerance for the pre-smoothing simplification pass, in traced-
 * pixel units. Large enough to fully erase 1px Moore-Neighbor stair
 * noise (whose max perpendicular deviation from the implied diagonal is
 * ~0.707px), small enough that no real corner or curve feature at
 * raster scale is perceptibly displaced.
 *
 * Audit vs Rule 1 / SHARP_CORNER_COS_MAX: at maxDimension=1200 fitted to
 * a 50 mm cavity, 0.9 px ≈ 0.037 mm. Letter notches and star tips at
 * trace resolution span many pixels, so ε cannot swallow them; RDP only
 * drops 1 px stair vertices. Sharp-corner pinning runs AFTER this pass
 * and independently protects ≥35° turns that survive RDP. */
const RDP_SIMPLIFY_TOLERANCE_PX = 0.9

/** Applies RDP to a CLOSED loop by splitting it into two open chains at
 * its two most distant points (an approximate diameter), simplifying
 * each chain independently, then rejoining. This is the standard trick
 * for running an endpoint-preserving open-curve algorithm on a closed
 * contour without arbitrarily biasing which single vertex stays
 * "anchored" (anchoring at just one point, e.g. index 0, would let RDP
 * over-simplify the arc furthest from it). */
function simplifyClosedLoopRDP(points, epsilon) {
  const n = points.length
  if (n < 5) return points

  const p0 = points[0]
  let farIdx = 0
  let farDistSq = 0
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - p0.x
    const dy = points[i].y - p0.y
    const dSq = dx * dx + dy * dy
    if (dSq > farDistSq) {
      farDistSq = dSq
      farIdx = i
    }
  }
  if (farIdx === 0) return points

  const chainA = points.slice(0, farIdx + 1)
  const chainB = points.slice(farIdx).concat([p0])

  const simplifiedA = rdpOpen(chainA, epsilon)
  const simplifiedB = rdpOpen(chainB, epsilon)

  const merged = simplifiedA.slice(0, -1).concat(simplifiedB.slice(0, -1))
  return merged.length >= 3 ? merged : points
}

/** Absolute floor: always melt 1–3 px Moore-Neighbor stairs. */
const PIXEL_EDGE_PX = 3.5

/** Fraction of the silhouette's shorter side. Raster "flats" on a
 * circle are O(√r) and fall below this; a square side or star arm is a
 * large fraction of the bbox and stays pinned. */
const MACRO_EDGE_FRAC = 0.22

/** Turn-angle floor (degrees) above which a vertex is treated as a
 * genuine corner and is NEVER smoothed by `laplacianShortEdges` or
 * `chaikinPreserveSharp` below, no matter how short its adjacent edges are.
 * Expressed as a cosine so the per-vertex test is a single dot product:
 * cos(35°) ≈ 0.819. Incoming·outgoing <= this value means the turn is
 * sharp enough to pin. */
const SHARP_CORNER_COS_MAX = 0.819

/** cos(turn angle) between the incoming edge (prev→curr) and outgoing
 * edge (curr→next) directions — 1 for a perfectly straight pass-through,
 * down to -1 for a full reversal. Degenerates to "straight" (1) if either
 * adjacent edge is zero-length, so a degenerate vertex is never
 * mistaken for a sharp corner. */
function turnCos(prev, curr, next) {
  const inX = curr.x - prev.x
  const inY = curr.y - prev.y
  const outX = next.x - curr.x
  const outY = next.y - curr.y
  const linLen = Math.hypot(inX, inY)
  const loutLen = Math.hypot(outX, outY)
  if (linLen < 1e-9 || loutLen < 1e-9) return 1
  return (inX * outX + inY * outY) / (linLen * loutLen)
}

/** Flags every vertex whose turn angle meets `SHARP_CORNER_TURN_DEG` — a
 * genuine corner that must survive the smoothing passes below untouched,
 * as opposed to a shallow curve chord that's safe to round further. */
function computeSharpCorners(points) {
  const n = points.length
  const sharp = new Array(n)
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const curr = points[i]
    const next = points[(i + 1) % n]
    sharp[i] = turnCos(prev, curr, next) <= SHARP_CORNER_COS_MAX
  }
  return sharp
}

function loopSize(points) {
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
      return { w: maxX - minX, h: maxY - minY }
    }
    
const TAUBIN_LAMBDA = 0.33
const TAUBIN_MU = -0.34
const TAUBIN_CYCLES = 8
const CHAIKIN_PASSES = 4

/** Do not Chaikin-cut edges already shorter than this (traced px). Four
 *  length-agnostic passes would otherwise explode a noisy outline. */
const MIN_CHAIKIN_EDGE_PX = 0.75

/** After Chaikin, split remaining curve-run chords longer than this so a
 *  long residual edge cannot extrude as a planar wall. Sharp-to-sharp
 *  sides (square, star arm) are left as a single segment. */
const MAX_CHORD_PX = 2.5

/**
 * Strict Simplify-then-Smooth on one closed Moore-Neighbor contour:
 *   1. Collapse exact-collinear mid-edge samples (lossless).
 *   2. RDP (ε ≈ 0.9px) drops residual staircase vertices.
 *   3. Taubin λ/μ Laplacian, 8 cycles, only on short non-sharp edges.
 *   4. Chaikin corner-cutting (Q=1/4, R=3/4), four passes, length-agnostic.
 *      Sharp vertices stay pinned; adjacent long non-sharp runs still cut.
 *
 * Genuine corners (turn ≥ 35°, incoming·outgoing ≤ 0.819) are classified
 * once after RDP and that flag set is frozen through Taubin + Chaikin so
 * subdivision cannot reclassify a true corner as a curve.
 */
function destaircaseLoop(points) {
  let pts = collapseCollinear(points)
  pts = simplifyClosedLoopRDP(pts, RDP_SIMPLIFY_TOLERANCE_PX)
  const { w, h } = loopSize(pts)
  const maxEdge = Math.max(PIXEL_EDGE_PX, MACRO_EDGE_FRAC * Math.min(w, h))
  let sharp = computeSharpCorners(pts)
  for (let cycle = 0; cycle < TAUBIN_CYCLES; cycle++) {
    pts = laplacianShortEdges(pts, TAUBIN_LAMBDA, maxEdge, sharp)
    pts = laplacianShortEdges(pts, TAUBIN_MU, maxEdge, sharp)
  }
  for (let pass = 0; pass < CHAIKIN_PASSES; pass++) {
    const result = chaikinPreserveSharp(pts, sharp, MIN_CHAIKIN_EDGE_PX)
    pts = result.points
    sharp = result.sharp
  }
  const densified = densifyLongChords(pts, sharp, MAX_CHORD_PX)
  pts = densified.points
  return stripDuplicateVertices(pts)
}
    
    /** p' = (1-w)·p + w·mid(prev,next). Only vertices with two short edges
     * AND a shallow (non-corner) turn angle move — a long-edge corner
     * (square, star tip) is pinned by length, and a short-but-sharp corner
     * (small notch/tab/letter) is independently pinned by `sharp[i]`, so
     * neither is ever pulled inward. */
    function laplacianShortEdges(points, weight, maxEdge, sharp) {
      const n = points.length
      if (n < 4) return points
      const out = new Array(n)
      for (let i = 0; i < n; i++) {
        const prev = points[(i - 1 + n) % n]
        const curr = points[i]
        const next = points[(i + 1) % n]
        const lin = Math.hypot(curr.x - prev.x, curr.y - prev.y)
        const lout = Math.hypot(next.x - curr.x, next.y - curr.y)
        if (lin < maxEdge && lout < maxEdge && !sharp[i]) {
          out[i] = {
            x: curr.x * (1 - weight) + weight * 0.5 * (prev.x + next.x),
            y: curr.y * (1 - weight) + weight * 0.5 * (prev.y + next.y),
          }
        } else {
          out[i] = curr
        }
      }
      return out
    }
    
    /**
     * Classic Chaikin (Q=1/4, R=3/4), length-agnostic, with the sharp-corner
     * pin split from the chord cut:
     *   - both endpoints sharp → keep A uncut (square side / star arm)
     *   - neither sharp → emit Q, R (curve run densifies and rounds)
     *   - only A sharp → keep A, still emit R so the long residual chord
     *     toward the curve run subdivides without chamfering A
     *   - only B sharp → emit Q (cut the curve side, B is emitted next)
     *
     * Sharp flags are propagated, not recomputed: new Chaikin vertices are
     * never sharp, so a true corner cannot be reclassified mid-subdivision.
     */
    function chaikinPreserveSharp(points, sharp, minEdge = 0) {
      const n = points.length
      if (n < 3) return { points, sharp }
      const out = []
      const outSharp = []
      for (let i = 0; i < n; i++) {
        const a = points[i]
        const b = points[(i + 1) % n]
        const aSharp = !!sharp[i]
        const bSharp = !!sharp[(i + 1) % n]
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        // Floor only — never a maxEdge ceiling. Long residual chords next
        // to a sharp vertex must still densify; already-short edges stay
        // put so four passes cannot explode vertex count.
        if (len <= minEdge) {
          out.push({ x: a.x, y: a.y })
          outSharp.push(aSharp)
          continue
        }
        if (!aSharp && !bSharp) {
          out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
          outSharp.push(false)
          out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
          outSharp.push(false)
        } else if (aSharp && !bSharp) {
          out.push({ x: a.x, y: a.y })
          outSharp.push(true)
          out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
          outSharp.push(false)
        } else if (!aSharp && bSharp) {
          out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
          outSharp.push(false)
        } else {
          out.push({ x: a.x, y: a.y })
          outSharp.push(true)
        }
      }
      return out.length >= 3 ? { points: out, sharp: outSharp } : { points, sharp }
    }

    /** Insert vertices on curve-run edges longer than `maxChord`. Both
     *  endpoints sharp ⇒ a true straight side, left as one segment. */
    function densifyLongChords(points, sharp, maxChord) {
      const n = points.length
      if (n < 3 || !(maxChord > 0)) return { points, sharp }
      const out = []
      const outSharp = []
      for (let i = 0; i < n; i++) {
        const a = points[i]
        const b = points[(i + 1) % n]
        const aSharp = !!sharp[i]
        const bSharp = !!sharp[(i + 1) % n]
        out.push({ x: a.x, y: a.y })
        outSharp.push(aSharp)
        if (aSharp && bSharp) continue
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        if (len <= maxChord) continue
        const parts = Math.ceil(len / maxChord)
        for (let k = 1; k < parts; k++) {
          const t = k / parts
          out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
          outSharp.push(false)
        }
      }
      return out.length >= 3 ? { points: out, sharp: outSharp } : { points, sharp }
    }
    
    // 8 neighbor offsets around a pixel, in CLOCKWISE order starting from due
    // West — the fixed search order Moore-Neighbor tracing sweeps through
    // looking for the next boundary pixel.
    const MOORE_NEIGHBORS = [
      [-1, 0], // W
      [-1, -1], // NW
      [0, -1], // N
      [1, -1], // NE
      [1, 0], // E
      [1, 1], // SE
      [0, 1], // S
      [-1, 1], // SW
    ]
    
    /**
     * Classic Moore-Neighbor boundary tracing (the "square tracing
     * algorithm"): walks pixel-to-pixel around the outside of one connected
     * foreground region, starting from a known boundary pixel, producing an
     * ordered closed polygon of pixel-center `{x, y}` coordinates.
     *
     * `isForeground(x, y)` decides blob membership (out-of-bounds is always
     * background) — the SAME function traces both a solid blob's outer
     * boundary and a hole's boundary (a hole is just "foreground" from the
     * perspective of its own enclosed background-pixel component).
     *
     * `startX`/`startY` MUST be that component's topmost-then-leftmost pixel
     * (exactly what raster-scan labeling naturally finds first — see
     * `labelComponents`), which guarantees its West neighbor is background:
     * the precondition the algorithm's initial search direction relies on.
     */
    function traceMooreBoundary(isForeground, startX, startY) {
      const boundary = [{ x: startX, y: startY }]
    
      // backtrackIdx=0 (West) is valid for the FIRST search because of the
      // topmost-leftmost start-pixel guarantee described above.
      let cx = startX
      let cy = startY
      let backtrackIdx = 0
    
      const findNext = () => {
        for (let i = 1; i <= 8; i++) {
          const idx = (backtrackIdx + i) % 8
          const [dx, dy] = MOORE_NEIGHBORS[idx]
          const nx = cx + dx
          const ny = cy + dy
          if (isForeground(nx, ny)) return { x: nx, y: ny, idx }
        }
        return null
      }
    
      const first = findNext()
      if (!first) return boundary // isolated single-pixel "blob" — caller discards (< 3 points)
    
      const p0 = { x: startX, y: startY }
      const b1 = { x: first.x, y: first.y }
    
      cx = first.x
      cy = first.y
      backtrackIdx = (first.idx + 4) % 8
      boundary.push({ x: cx, y: cy })
    
      const maxSteps = 4_000_000 // hard safety net; a real trace never remotely approaches this
      for (let step = 0; step < maxSteps; step++) {
        const next = findNext()
        if (!next) break // shouldn't happen once ≥1 neighbor has been found, but stay safe
    
        const prevPixel = { x: cx, y: cy }
        backtrackIdx = (next.idx + 4) % 8
        cx = next.x
        cy = next.y
    
        // Jacob's stopping criterion: stop once the walk is about to repeat
        // the EXACT first transition (p0 -> b1) — not merely once it revisits
        // p0's coordinates, which can happen mid-trace (without the loop
        // actually being complete) on a shape with a one-pixel-wide pinch
        // point touching itself.
        if (prevPixel.x === p0.x && prevPixel.y === p0.y && cx === b1.x && cy === b1.y) {
          break
        }
        // Closed the loop by returning to the start pixel — don't push a
        // duplicate of p0 (that zero-length edge would break collinear collapse).
        if (cx === p0.x && cy === p0.y) break
    
        boundary.push({ x: cx, y: cy })
      }
    
      return boundary
    }
    
    /**
     * Labels every 4- or 8-connected component of pixels matching `value` in a
     * binary grid (flood fill), returning per-pixel labels plus each
     * component's pixel count, whether it touches the image border, and its
     * topmost-then-leftmost pixel (the exact start-pixel Moore-Neighbor
     * tracing needs — see `traceMooreBoundary`'s doc comment).
     *
     * Connectivity is a parameter rather than always 8 because a binary
     * image's foreground and background must use OPPOSITE connectivity rules
     * (8-connected foreground / 4-connected background, or vice versa) to stay
     * topologically consistent — using the same rule for both can let a
     * foreground diagonal "bridge" and a background diagonal "gap" both claim
     * the same pixel crossing, which is the textbook connectivity paradox.
     * This app uses 8-connected solid blobs (so a diagonally-thin star point
     * stays one connected piece) paired with 4-connected background holes.
     */
    function labelComponents(grid, w, h, value, connectivity) {
      const n = w * h
      const labels = new Int32Array(n).fill(-1)
      const comps = []
      const stack = []
      const offsets =
        connectivity === 8
          ? [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ]
          : [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]
    
      for (let idx = 0; idx < n; idx++) {
        if (grid[idx] !== value || labels[idx] !== -1) continue
    
        const label = comps.length
        const seedX = idx % w
        const seedY = (idx / w) | 0
        let size = 0
        let touchesBorder = false
    
        labels[idx] = label
        stack.length = 0
        stack.push(idx)
    
        while (stack.length > 0) {
          const cur = stack.pop()
          size++
          const x = cur % w
          const y = (cur / w) | 0
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true
    
          for (const [dx, dy] of offsets) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            const nIdx = ny * w + nx
            if (grid[nIdx] === value && labels[nIdx] === -1) {
              labels[nIdx] = label
              stack.push(nIdx)
            }
          }
        }
    
        comps.push({ label, size, touchesBorder, seedX, seedY })
      }
    
      return { labels, comps }
    }
    
    /**
 * Extracts the traced silhouette from a binary pixel grid: every
 * 8-connected solid blob big enough to clear the noise filter, each as
 * its own outer boundary, plus the boundary of every 4-connected
 * background region fully enclosed within any of them (a real hole — a
 * donut's middle, a letter "O" — as opposed to the one giant background
 * region surrounding the whole shape, which always touches the image
 * border and is never mistaken for a hole).
 *
 * Defense against stray blobs raster photos/JPGs routinely leave behind
 * after a hard threshold (compression ringing, background speckle): the
 * minimum-area noise filter scales with image resolution instead of a
 * fixed tiny pixel count, so it reliably clears JPEG-block-sized (8x8px)
 * artifacts at any trace resolution, not just one specific `maxDimension`.
 *
 * Every blob that clears that filter is traced — not just the single
 * largest one. A hand-drawn line-art upload routinely has interior
 * details (an eye, a nose, a bow) that don't share a single ink pixel
 * with the main outline, so restricting tracing to "the largest blob
 * only" silently dropped every one of them before "Stamp" mode
 * (`buildStampGeometry` in `cutterGeometry.js`) ever saw them — it needs
 * every interior detail loop to emboss, not just the outer silhouette.
 * Picking which ONE contour is the "outer" cutter-wall/plate boundary
 * (always the single largest by enclosed area — everything else nests
 * inside it, or is dropped as a stray secondary shape) is deliberately
 * NOT this function's job anymore: it happens downstream, in
 * `clipperWrapper.js`'s `splitOuterAndHoles`/`isolateOuterContour`, right
 * before the "Cutter"-mode wall (or "Stamp"-mode plate) is actually built.
 */
function traceGridContours(grid, w, h) {
  const MIN_AREA_PX = Math.max(6, w * h * 0.0005)

  const { labels: solidLabels, comps: solidComps } = labelComponents(grid, w, h, 1, 8)
  if (solidComps.length === 0) return []

  const significantBlobs = solidComps.filter((c) => c.size >= MIN_AREA_PX)
  if (significantBlobs.length === 0) return []

  const contours = []
  for (const blob of significantBlobs) {
    const isBlobSolid = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false
      const idx = y * w + x
      return grid[idx] === 1 && solidLabels[idx] === blob.label
    }

    const outerRaw = traceMooreBoundary(isBlobSolid, blob.seedX, blob.seedY)
    if (outerRaw.length < 3) continue
    contours.push(normalizeWinding(outerRaw, true))
  }
  if (contours.length === 0) return []

  const { labels: bgLabels, comps: bgComps } = labelComponents(grid, w, h, 0, 4)
  for (const c of bgComps) {
    if (c.touchesBorder) continue // the surrounding background, not a hole
    if (c.size < MIN_AREA_PX) continue

    const isHolePixel = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false
      const idx = y * w + x
      return grid[idx] === 0 && bgLabels[idx] === c.label
    }

    const holeRaw = traceMooreBoundary(isHolePixel, c.seedX, c.seedY)
    if (holeRaw.length < 3) continue
    contours.push(normalizeWinding(holeRaw, false))
  }

  return contours
}