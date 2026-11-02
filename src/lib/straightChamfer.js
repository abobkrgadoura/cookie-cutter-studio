import * as THREE from 'three'
import { triangulatePolygons } from './manifoldEngine.js'

/**
 * Straight-line blade chamfer.
 *
 * The outer wall is a ruled surface: every vertex on the thick base contour
 * (offset = blade thickness) is connected to its mate on the tip contour
 * (offset = tip width) by one straight edge. No Z slices, no curved loft.
 *
 * The base contour is the offsetter's polygon, unchanged, so it is the same
 * loop the vertical blade wall is extruded from. The two contours are
 * parallel offsets of one cavity, so a mate is the point that shares the
 * offset normal — not the nearest point, and not the same arc-length
 * fraction. A thick round join is a longer arc of the same angle, and a
 * concave bisector grows as 1/sin(half-angle), far past the wall thickness.
 * Proximity matching crosses those generators.
 *
 * Each base vertex is fired inward along its miter bisector. The first
 * front-facing hit on the tip is the mate, including a sharp V whose
 * bisector is many times the wall thickness. Hit parameters are projected
 * onto a non-decreasing index sequence around the closed tip, so neighboring
 * generators may meet but cannot cross. The tip contour in the mesh is the
 * real tip offset, so a V is never replaced by a chord.
 *
 * The blade shell is closed: vertical outer wall, ruled chamfer, vertical
 * inner wall on the 1:1 cavity, and annulus caps. Manifold-3d validates it.
 */

const DEDUPE_EPS_MM = 1e-6
const DEGENERATE_CROSS2 = 1e-16

function polygonArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function dedupeClosed(points, eps = DEDUPE_EPS_MM) {
  const out = []
  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const q = { x: p.x, y: p.y }
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(q.x - prev.x, q.y - prev.y) > eps) out.push(q)
  }
  if (out.length > 1) {
    const a = out[0]
    const b = out[out.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) out.pop()
  }
  return out
}

function ensureCCW(points) {
  if (points.length < 3) return points
  return polygonArea(points) < 0 ? points.slice().reverse() : points
}

/**
 * Keep every original vertex (so round-join arcs stay at the offsetter's
 * resolution) and split only edges longer than `maxChord`.
 */
export function densifyClosedLoop(points, maxChord) {
  const src = dedupeClosed(points)
  if (src.length < 3 || !(maxChord > 0)) return src
  const out = []
  const n = src.length
  for (let i = 0; i < n; i++) {
    const a = src[i]
    const b = src[(i + 1) % n]
    out.push({ x: a.x, y: a.y })
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len <= maxChord) continue
    const pieces = Math.ceil(len / maxChord)
    for (let s = 1; s < pieces; s++) {
      const t = s / pieces
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      })
    }
  }
  return out
}

function miterInwardNormals(loop) {
  const n = loop.length
  const edge = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    // CCW walk: left normal points into the polygon.
    edge[i] = { x: -dy / len, y: dx / len }
  }
  const normals = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = edge[(i - 1 + n) % n]
    const b = edge[i]
    let x = a.x + b.x
    let y = a.y + b.y
    let len = Math.hypot(x, y)
    if (len < 1e-8) {
      x = b.x
      y = b.y
      len = 1
    }
    normals[i] = { x: x / len, y: y / len }
  }
  return normals
}

const RAY_CELL_MM = 3

/**
 * Uniform grid of tip-loop edges so an inward ray tests only the cells it
 * crosses. The hit itself is still an exact segment intersection.
 */
function buildEdgeGrid(loop, cell = RAY_CELL_MM) {
  let minX = Infinity
  let minY = Infinity
  for (const p of loop) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
  }
  minX -= cell
  minY -= cell
  const buckets = new Map()
  const m = loop.length
  const keyOf = (c, r) => c + r * 65536
  for (let j = 0; j < m; j++) {
    const a = loop[j]
    const b = loop[(j + 1) % m]
    const c0 = Math.floor((Math.min(a.x, b.x) - minX) / cell)
    const c1 = Math.floor((Math.max(a.x, b.x) - minX) / cell)
    const r0 = Math.floor((Math.min(a.y, b.y) - minY) / cell)
    const r1 = Math.floor((Math.max(a.y, b.y) - minY) / cell)
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = keyOf(c, r)
        let bucket = buckets.get(key)
        if (!bucket) buckets.set(key, (bucket = []))
        bucket.push(j)
      }
    }
  }
  return {
    buckets,
    minX,
    minY,
    cell,
    keyOf,
    stamp: new Int32Array(m),
    mark: 1,
  }
}

/**
 * First place the ray `origin + t * dir` (t > 0) meets a front-facing edge
 * of the CCW tip. Facing rejects the far wall: its inward normal points
 * back toward the ray, so a concave bisector cannot lock onto the opposite
 * side of the cutter. Returns a continuous edge parameter in [0, m).
 */
function firstFacingHit(origin, dir, loop, grid, maxT) {
  const { buckets, minX, minY, cell, keyOf, stamp } = grid
  const m = loop.length
  let bestT = Infinity
  let bestS = null
  let mark = ++grid.mark
  if (mark >= 0x7fffffff) {
    stamp.fill(0)
    mark = grid.mark = 1
  }

  const consider = (j) => {
    if (stamp[j] === mark) return
    stamp[j] = mark
    const a = loop[j]
    const b = loop[(j + 1) % m]
    const ex = b.x - a.x
    const ey = b.y - a.y
    const elen = Math.hypot(ex, ey)
    if (elen < 1e-12) return
    const denom = dir.x * ey - dir.y * ex
    if (Math.abs(denom) < 1e-14) return
    const ox = a.x - origin.x
    const oy = a.y - origin.y
    const t = (ox * ey - oy * ex) / denom
    const u = (ox * dir.y - oy * dir.x) / denom
    if (!(t > 1e-5) || t >= bestT || t > maxT || u < -1e-4 || u > 1 + 1e-4) return
    // CCW left normal points into the tip polygon. An inward ray meets it
    // head-on, so the two directions agree.
    const facing = (dir.x * -ey + dir.y * ex) / elen
    if (facing < 0.05) return
    bestT = t
    const uu = u <= 0 ? 0 : u >= 1 ? 0.999999 : u
    bestS = j + uu
  }

  let cx = Math.floor((origin.x - minX) / cell)
  let cy = Math.floor((origin.y - minY) / cell)
  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0
  const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0
  const inf = Number.POSITIVE_INFINITY
  const tDeltaX = stepX !== 0 ? Math.abs(cell / dir.x) : inf
  const tDeltaY = stepY !== 0 ? Math.abs(cell / dir.y) : inf
  let tMaxX = inf
  let tMaxY = inf
  if (stepX > 0) tMaxX = (minX + (cx + 1) * cell - origin.x) / dir.x
  else if (stepX < 0) tMaxX = (minX + cx * cell - origin.x) / dir.x
  if (stepY > 0) tMaxY = (minY + (cy + 1) * cell - origin.y) / dir.y
  else if (stepY < 0) tMaxY = (minY + cy * cell - origin.y) / dir.y
  if (tMaxX < 0) tMaxX = 0
  if (tMaxY < 0) tMaxY = 0

  for (let step = 0; step < 4096; step++) {
    const bucket = buckets.get(keyOf(cx, cy))
    if (bucket) {
      for (let k = 0; k < bucket.length; k++) consider(bucket[k])
    }
    const nextT = tMaxX < tMaxY ? tMaxX : tMaxY
    if (nextT > bestT || nextT > maxT) break
    if (tMaxX < tMaxY) {
      if (stepX === 0) break
      cx += stepX
      tMaxX += tDeltaX
    } else {
      if (stepY === 0) break
      cy += stepY
      tMaxY += tDeltaY
    }
  }
  return bestS
}

/**
 * Replace missed rays by interpolating the tip-edge parameter between the
 * neighboring hits. A single gap stays on the same normal family as the
 * samples around it.
 */
function fillMisses(raw, m) {
  const n = raw.length
  const known = []
  for (let i = 0; i < n; i++) if (raw[i] != null) known.push(i)
  if (known.length === 0) return null
  if (known.length === n) return raw
  const out = raw.slice()
  for (let k = 0; k < known.length; k++) {
    const a = known[k]
    const b = known[(k + 1) % known.length]
    const span = (b - a + n) % n
    if (span <= 1) continue
    let sb = out[b]
    while (sb < out[a]) sb += m
    // A gap that jumps more than half a turn is not a local miss; leave it
    // for the monotone projection to pin rather than stretching across.
    if (sb - out[a] > m * 0.5) {
      for (let s = 1; s < span; s++) out[(a + s) % n] = out[a]
      continue
    }
    for (let s = 1; s < span; s++) {
      let v = out[a] + ((sb - out[a]) * s) / span
      v %= m
      if (v < 0) v += m
      out[(a + s) % n] = v
    }
  }
  return out
}

/**
 * Lift hit parameters onto one non-decreasing pass around the tip.
 * A one-vertex dip keeps its closest circular representative and is then
 * clamped forward — it is never promoted by a full turn, which is what made
 * a tiny numerical reversal twist the rest of the loft.
 */
function monotoneParameters(raw, m) {
  const filled = fillMisses(raw, m)
  if (!filled) return null
  const n = filled.length
  let anchor = 0
  let bestSpread = Infinity
  for (let i = 0; i < n; i++) {
    const prev = filled[(i - 1 + n) % n]
    const next = filled[(i + 1) % n]
    if (prev == null || filled[i] == null || next == null) continue
    const dp = ((filled[i] - prev) % m + m) % m
    const dn = ((next - filled[i]) % m + m) % m
    if (dp > m * 0.5 || dn > m * 0.5) continue
    const spread = dp + dn
    if (spread < bestSpread) {
      bestSpread = spread
      anchor = i
    }
  }

  const unwrapped = new Array(n)
  unwrapped[anchor] = filled[anchor] ?? 0
  for (let k = 1; k < n; k++) {
    const i = (anchor + k) % n
    const prevU = unwrapped[(i - 1 + n) % n]
    let s = filled[i]
    if (s == null) {
      unwrapped[i] = prevU
      continue
    }
    while (s - prevU > m * 0.5) s -= m
    while (prevU - s > m * 0.5) s += m
    unwrapped[i] = s < prevU ? prevU : s
  }

  const base = unwrapped[0]
  for (let i = 0; i < n; i++) {
    let v = unwrapped[i]
    while (v < base - 1e-9) v += m
    while (v >= base + m) v -= m
    unwrapped[i] = v
  }
  for (let i = 1; i < n; i++) {
    if (unwrapped[i] < unwrapped[i - 1]) unwrapped[i] = unwrapped[i - 1]
  }
  return unwrapped
}

/**
 * Map each base vertex onto a vertex of the tip loop.
 *
 * The mate is the first front-facing intersection of the inward miter ray
 * with the tip. Parameters are then projected to a non-decreasing unwrapped
 * index (`topIndex[i] <= topIndex[i + 1]`, one full turn on closure), which
 * is the condition that keeps ruled generators from crossing.
 *
 * `bottom` is the offset polygon itself, so the chamfer base matches the
 * vertical wall.
 */
export function pairOffsetContours(bottomLoop, topLoop, options = {}) {
  const bottom = ensureCCW(dedupeClosed(bottomLoop))
  const top = ensureCCW(dedupeClosed(topLoop))
  if (bottom.length < 3 || top.length < 3) return null

  const n = bottom.length
  const m = top.length
  const normals = miterInwardNormals(bottom)
  const grid = buildEdgeGrid(top)
  const radialGap = options.radialGap ?? 0
  // A concave bisector is gap / sin(half-angle). 40× still clears a ~1.5°
  // notch; anything longer is a degenerate sliver, not a mate.
  const maxT = Math.max(250, radialGap * 40)

  const raw = new Array(n)
  for (let i = 0; i < n; i++) {
    raw[i] = firstFacingHit(bottom[i], normals[i], top, grid, maxT)
  }

  const params = monotoneParameters(raw, m)
  if (!params) return null
  const embedded = embedRayHits(top, params)
  if (!embedded) return null
  return { bottom, top: embedded.top, topIndex: embedded.topIndex }
}

/**
 * Split tip edges at the ray hits so each ruling lands on the normal, not
 * on a snapped corner of a long edge. Original vertices stay where they
 * are, so a sharp V is never replaced by a chord. Hits within the weld
 * tolerance of a vertex are glued to that vertex.
 */
function embedRayHits(top, params) {
  const n = params.length
  const m = top.length
  const base = params[0]
  const span = base + m
  const items = []

  for (let j = 0; j < m; j++) {
    let p = j
    while (p < base - 1e-7) p += m
    while (p >= span - 1e-7) p -= m
    const v = top[mod(j, m)]
    items.push({ p, hit: -1, x: v.x, y: v.y, vertex: true })
  }

  const deferred = []
  for (let i = 0; i < n; i++) {
    let p = params[i]
    if (p >= span - 1e-4) {
      deferred.push(i)
      continue
    }
    if (p < base) p = base
    let j = Math.floor(p)
    let u = p - j
    if (u >= 1 - 1e-6) {
      j += 1
      u = 0
    }
    const a = top[mod(j, m)]
    const b = top[mod(j + 1, m)]
    items.push({
      p: j + u,
      hit: i,
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      vertex: u <= 1e-6,
    })
  }

  items.sort((a, b) => a.p - b.p || (a.vertex === b.vertex ? 0 : a.vertex ? -1 : 1))

  const MERGE_MM = 1e-4
  const loop = []
  const topIndex = new Array(n)
  for (const item of items) {
    const prev = loop[loop.length - 1]
    const close = prev && Math.hypot(prev.x - item.x, prev.y - item.y) <= MERGE_MM
    let idx
    if (close) {
      idx = loop.length - 1
      if (item.vertex) {
        prev.x = item.x
        prev.y = item.y
        prev.vertex = true
      }
    } else {
      idx = loop.length
      loop.push({ x: item.x, y: item.y, vertex: item.vertex })
    }
    if (item.hit >= 0) topIndex[item.hit] = idx
  }

  const seamHits = []
  if (loop.length > 1) {
    const a = loop[0]
    const b = loop[loop.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) <= MERGE_MM) {
      const dropped = loop.length - 1
      loop.pop()
      for (let i = 0; i < n; i++) if (topIndex[i] === dropped) seamHits.push(i)
    }
  }

  if (loop.length < 3) return null
  const newM = loop.length
  for (const i of seamHits) topIndex[i] = (topIndex[0] ?? 0) + newM
  for (const i of deferred) topIndex[i] = (topIndex[0] ?? 0) + newM
  for (let i = 0; i < n; i++) {
    if (topIndex[i] == null) topIndex[i] = i === 0 ? 0 : topIndex[i - 1]
  }
  for (let i = 1; i < n; i++) {
    if (topIndex[i] < topIndex[i - 1]) topIndex[i] = topIndex[i - 1]
  }
  const hi = topIndex[0] + newM
  for (let i = 1; i < n; i++) {
    if (topIndex[i] > hi) topIndex[i] = hi
    if (topIndex[i] < topIndex[i - 1]) topIndex[i] = topIndex[i - 1]
  }

  const clean = new Array(newM)
  for (let i = 0; i < newM; i++) clean[i] = { x: loop[i].x, y: loop[i].y }
  return { top: clean, topIndex }
}

function pushTri(indices, positions, a, b, c) {
  if (a === b || b === c || c === a) return
  const ax = positions[a * 3]
  const ay = positions[a * 3 + 1]
  const az = positions[a * 3 + 2]
  const bx = positions[b * 3]
  const by = positions[b * 3 + 1]
  const bz = positions[b * 3 + 2]
  const cx = positions[c * 3]
  const cy = positions[c * 3 + 1]
  const cz = positions[c * 3 + 2]
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  const cross = (uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2
  if (cross < DEGENERATE_CROSS2) return
  indices.push(a, b, c)
}

function signedVolume(positions, indices) {
  let v = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3
    const ax = positions[a]
    const ay = positions[a + 1]
    const az = positions[a + 2]
    const bx = positions[b]
    const by = positions[b + 1]
    const bz = positions[b + 2]
    const cx = positions[c]
    const cy = positions[c + 1]
    const cz = positions[c + 2]
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
  }
  return v / 6
}

/**
 * Disk cap of one CCW loop. `flip` sends the normal along -Z.
 * The cavity is NOT cut here — earcut drops a hole edge, so the ring is
 * opened afterwards by a manifold difference of the extruded cavity.
 */
function appendDiskCap(indices, positions, pts, base, flip) {
  if (polygonArea(pts) <= 0) return false
  const faces = triangulatePolygons([pts])
  if (!faces || faces.length === 0) return false
  const before = indices.length
  for (const face of faces) {
    if (face[0] >= pts.length || face[1] >= pts.length || face[2] >= pts.length) return false
    const a = base + face[0]
    const b = base + face[1]
    const c = base + face[2]
    if (flip) pushTri(indices, positions, a, c, b)
    else pushTri(indices, positions, a, b, c)
  }
  return indices.length > before
}

function mod(a, m) {
  return ((a % m) + m) % m
}

/**
 * Ruled chamfer. Each base vertex connects to its tip vertex by one straight
 * edge. Every tip-loop edge between those vertices is kept, so a sharp V
 * that sits between two samples is still a vertex of the tip, and a locked
 * apex is connected directly to its base apex.
 */
function appendRuledStrip(indices, positions, bottomBase, topBase, topIndex, topCount) {
  const n = topIndex.length
  const m = topCount
  if (n < 3 || m < 3) return false
  for (let i = 0; i < n; i++) {
    const b0 = bottomBase + i
    const b1 = bottomBase + ((i + 1) % n)
    const u0 = topIndex[i]
    const u1 = i + 1 < n ? topIndex[i + 1] : topIndex[0] + m
    const end = u1 >= u0 ? u1 : u0
    if (end - u0 > m) return false
    pushTri(indices, positions, b0, b1, topBase + mod(u0, m))
    for (let u = u0; u < end; u++) {
      pushTri(indices, positions, b1, topBase + mod(u + 1, m), topBase + mod(u, m))
    }
  }
  return true
}

/**
 * Closed solid between the thick base contour and the sharp tip contour.
 * Longitudinal edges are single straight segments (a ruled quad strip).
 * The solid still contains the dough cavity; `buildBladeGeometry` subtracts
 * that cavity with manifold so the cutting edge stays the 1:1 trace.
 * Returns null if the contours cannot be paired into a closed shell.
 */
export function buildStraightChamferGeometry(bottomLoop, topLoop, zBottom, zTop, options = {}) {
  if (!(zTop - zBottom > 0.02)) return null
  const radialGap = options.radialGap ?? 0.5
  const paired = pairOffsetContours(bottomLoop, topLoop, { ...options, radialGap })
  if (!paired) return null
  if (polygonArea(paired.top) <= 0) return null

  const positions = []
  const bottomBase = 0
  for (const p of paired.bottom) positions.push(p.x, p.y, zBottom)
  const topBase = paired.bottom.length
  for (const p of paired.top) positions.push(p.x, p.y, zTop)

  const indices = []
  if (!appendRuledStrip(indices, positions, bottomBase, topBase, paired.topIndex, paired.top.length)) {
    return null
  }

  const topCapOk = appendDiskCap(indices, positions, paired.top, topBase, false)
  const bottomCapOk = appendDiskCap(indices, positions, paired.bottom, bottomBase, true)
  if (!topCapOk || !bottomCapOk || indices.length < 12) return null

  if (signedVolume(positions, indices) < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const tmp = indices[i + 1]
      indices[i + 1] = indices[i + 2]
      indices[i + 2] = tmp
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
  geo.computeVertexNormals()
  return geo
}

function readLoop(positions, base, count) {
  const pts = new Array(count)
  for (let i = 0; i < count; i++) {
    const o = (base + i) * 3
    pts[i] = { x: positions[o], y: positions[o + 1] }
  }
  return pts
}

/**
 * Annulus cap on vertices that already exist in `positions`.
 * Outer loop stays CCW. The hole is sent clockwise, which is the winding
 * manifold's triangulator treats as a hole rather than a second island.
 * `flip` turns the normal to -Z.
 */
function appendAnnulus(indices, positions, outerBase, outerCount, innerBase, innerCount, flip) {
  if (outerCount < 3 || innerCount < 3) return false
  const outerPts = readLoop(positions, outerBase, outerCount)
  if (polygonArea(outerPts) <= 0) return false
  const innerStored = readLoop(positions, innerBase, innerCount)
  const innerArea = polygonArea(innerStored)
  if (Math.abs(innerArea) < 1e-8) return false
  const reverse = innerArea > 0
  const innerPts = new Array(innerCount)
  const map = new Array(outerCount + innerCount)
  for (let i = 0; i < outerCount; i++) map[i] = outerBase + i
  for (let k = 0; k < innerCount; k++) {
    const i = reverse ? innerCount - 1 - k : k
    innerPts[k] = innerStored[i]
    map[outerCount + k] = innerBase + i
  }
  const faces = triangulatePolygons([outerPts, innerPts])
  if (!faces || faces.length === 0) return false
  const before = indices.length
  for (const face of faces) {
    if (face[0] >= map.length || face[1] >= map.length || face[2] >= map.length) return false
    const a = map[face[0]]
    const b = map[face[1]]
    const c = map[face[2]]
    if (flip) pushTri(indices, positions, a, c, b)
    else pushTri(indices, positions, a, b, c)
  }
  return indices.length > before
}

function addVerticalStrip(indices, positions, lowerBase, upperBase, count, outward) {
  for (let i = 0; i < count; i++) {
    const i2 = (i + 1) % count
    const a0 = lowerBase + i
    const a1 = lowerBase + i2
    const b0 = upperBase + i
    const b1 = upperBase + i2
    if (outward) {
      pushTri(indices, positions, a0, a1, b0)
      pushTri(indices, positions, a1, b1, b0)
    } else {
      pushTri(indices, positions, a0, b0, a1)
      pushTri(indices, positions, a1, b0, b1)
    }
  }
}

function shellIsClosed(indices) {
  const undirected = new Map()
  const directed = new Map()
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]]
    for (let e = 0; e < 3; e++) {
      const a = tri[e]
      const b = tri[(e + 1) % 3]
      const uk = a < b ? `${a}|${b}` : `${b}|${a}`
      undirected.set(uk, (undirected.get(uk) || 0) + 1)
      const dk = `${a}>${b}`
      directed.set(dk, (directed.get(dk) || 0) + 1)
    }
  }
  for (const count of undirected.values()) {
    if (count !== 2) return false
  }
  for (const [ek, count] of directed) {
    const [a, b] = ek.split('>')
    const rev = directed.get(`${b}>${a}`) || 0
    if (count !== 1 || rev !== 1) return false
  }
  return undirected.size > 0
}

/**
 * One closed blade shell: vertical outer wall, straight ruled chamfer,
 * vertical inner wall on the 1:1 cavity, and annulus caps.
 *
 * The chamfer and the vertical wall share the thick-offset vertices, so
 * there is no boolean seam and no stair. Longitudinal chamfer edges are
 * single straight segments from that shared loop up to the tip offset.
 * Returns null when the contours cannot be paired or the shell is open.
 */
export function buildStraightBladeShell({
  bottomLoop,
  topLoop,
  cavityLoop,
  zBase = 0,
  zSeam,
  zTip,
  radialGap = 0.5,
} = {}) {
  if (!(zTip - zSeam > 0.02) || !(zSeam - zBase > 0.02)) return null
  const paired = pairOffsetContours(bottomLoop, topLoop, { radialGap })
  if (!paired) return null
  const cavity = ensureCCW(dedupeClosed(cavityLoop))
  if (paired.bottom.length < 3 || paired.top.length < 3 || cavity.length < 3) return null
  if (polygonArea(paired.top) <= 0) return null

  const positions = []
  const addLoop = (pts, z) => {
    const base = positions.length / 3
    for (const p of pts) positions.push(p.x, p.y, z)
    return base
  }
  const vOuterBase = addLoop(paired.bottom, zBase)
  const vOuterSeam = addLoop(paired.bottom, zSeam)
  const vOuterTip = addLoop(paired.top, zTip)
  const vInnerBase = addLoop(cavity, zBase)
  const vInnerTip = addLoop(cavity, zTip)

  const indices = []
  addVerticalStrip(indices, positions, vOuterBase, vOuterSeam, paired.bottom.length, true)
  if (!appendRuledStrip(indices, positions, vOuterSeam, vOuterTip, paired.topIndex, paired.top.length)) {
    return null
  }

  addVerticalStrip(indices, positions, vInnerBase, vInnerTip, cavity.length, false)

  const topOk = appendAnnulus(indices, positions, vOuterTip, paired.top.length, vInnerTip, cavity.length, false)
  const bottomOk = appendAnnulus(
    indices,
    positions,
    vOuterBase,
    paired.bottom.length,
    vInnerBase,
    cavity.length,
    true,
  )
  if (!topOk || !bottomOk || !shellIsClosed(indices)) {
    console.warn('[straightChamfer] blade shell is not a closed surface')
    return null
  }

  if (signedVolume(positions, indices) < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const tmp = indices[i + 1]
      indices[i + 1] = indices[i + 2]
      indices[i + 2] = tmp
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
  geo.computeVertexNormals()
  return geo
}