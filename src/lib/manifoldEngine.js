import Module from 'manifold-3d'
import wasmUrl from 'manifold-3d/manifold.wasm?url'
import * as THREE from 'three'
import { mergeBufferGeometries, mergeVertices } from 'three-stdlib'

/**
 * WASM handle for manifold-3d. Initialization is async (the binary has to
 * be fetched and instantiated) but every geometry producer in this module
 * is then synchronous — `generateFullCutterModel` stays a sync function
 * as long as the worker awaits `initManifold()` first.
 */
let wasm = null
let initPromise = null

async function nodeWasmBinary() {
  if (typeof process === 'undefined' || !process.versions?.node) return null
  if (/^https?:/i.test(String(wasmUrl))) return null
  try {
    const fs = await import(/* @vite-ignore */ 'node:fs')
    const { createRequire } = await import(/* @vite-ignore */ 'node:module')
    const require = createRequire(import.meta.url)
    return fs.readFileSync(require.resolve('manifold-3d/manifold.wasm'))
  } catch {
    return null
  }
}

export async function initManifold() {
  if (wasm) return wasm
  if (!initPromise) {
    initPromise = (async () => {
      const wasmBinary = await nodeWasmBinary()
      const inst = await Module(wasmBinary ? { wasmBinary } : { locateFile: () => wasmUrl })
      inst.setup()
      hardenBatchBooleans(inst)
      wasm = inst
      return wasm
    })()
  }
  return initPromise
}

export function isManifoldReady() {
  return wasm !== null
}

/**
 * Triangulate outer/hole loops. Indices reference the concatenated vertex
 * order of `loops` (loop 0, then loop 1, ...). Manifold's triangulator
 * keeps every boundary edge; earcut drops a hole edge on plain rectangles.
 */
export function triangulatePolygons(loops) {
  const polygons = []
  for (const loop of loops || []) {
    if (!loop || loop.length < 3) continue
    polygons.push(loop.map((p) => [p.x, p.y]))
  }
  if (polygons.length === 0) return null
  try {
    const tris = getWasm().triangulate(polygons, 1e-7, false)
    return tris && tris.length > 0 ? tris : null
  } catch (err) {
    console.warn('[manifoldEngine] triangulatePolygons failed:', err)
    return null
  }
}

function getWasm() {
  if (!wasm) {
    throw new Error(
      '[manifoldEngine] manifold-3d is not initialized. The geometry worker must await initManifold() before generating a model.',
    )
  }
  return wasm
}

function toContours(paths) {
  const contours = []
  for (const loop of paths || []) {
    if (!loop || loop.length < 3) continue
    const contour = []
    for (const p of loop) contour.push([p.x, p.y])
    contours.push(contour)
  }
  return contours
}

function signedAreaXY(contour) {
  let area = 0
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]
    const b = contour[(i + 1) % contour.length]
    area += a[0] * b[1] - b[0] * a[1]
  }
  return area / 2
}

/**
 * Live CrossSection / Manifold handles. JS GC cannot see the WASM heap.
 * `trackWasm` increments; `wasmDelete` (or a direct `.delete()` on a
 * tracked object) decrements. `getWasmLeakCount()` is 0 when a generate
 * cycle has released every handle.
 *
 * Handles are also keyed by a scope id (`beginWasmScope`). A superseded
 * worker job calls `sweepWasmScope` on its own id, which `.delete()`s any
 * handle that scope still owns. A newer job's handles carry a later id, so
 * the sweep cannot free them.
 *
 * manifold-3d 3.5 `Mesh` and `getMesh()` results are plain JS values:
 * `vertProperties` / `triVerts` are already copies, and `Mesh` has no
 * `delete()`. They still go through `wasmDelete` so a binding that
 * returns a real handle is freed and counted.
 */
let wasmLiveCount = 0
let wasmScope = 0
const wasmLive = new Set()
const wasmScopeOf = new Map()

function trackWasm(obj) {
  if (!obj || typeof obj.delete !== 'function' || wasmLive.has(obj)) return obj
  const originalDelete = obj.delete.bind(obj)
  obj.delete = function deleteTrackedWasm() {
    if (!wasmLive.has(obj)) return undefined
    wasmLive.delete(obj)
    wasmScopeOf.delete(obj)
    wasmLiveCount -= 1
    try {
      return originalDelete()
    } catch {
      // Binding already freed the handle (failed boolean, double delete).
      return undefined
    }
  }
  wasmLive.add(obj)
  wasmScopeOf.set(obj, wasmScope)
  wasmLiveCount += 1
  return obj
}

function wasmDelete(obj) {
  if (!obj || typeof obj.delete !== 'function') return
  try {
    obj.delete()
  } catch {
    // Already freed, or not a WASM handle.
  }
}

export function getWasmLeakCount() {
  return wasmLiveCount
}

/** Opens a generate scope. Every handle tracked until the next call belongs to it. */
export function beginWasmScope() {
  wasmScope += 1
  return wasmScope
}

/**
 * `.delete()`s every handle still owned by `scopeId`. Returns how many
 * were released. Other scopes are left alone.
 */
export function sweepWasmScope(scopeId) {
  let released = 0
  for (const obj of [...wasmLive]) {
    if (wasmScopeOf.get(obj) !== scopeId) continue
    wasmDelete(obj)
    released += 1
  }
  return released
}

/**
 * Runs a manifold factory and tracks the handle. A throw still deletes a
 * handle the factory managed to return before failing.
 */
function allocWasm(factory) {
  let obj = null
  try {
    obj = trackWasm(factory())
    return obj
  } catch (err) {
    wasmDelete(obj)
    throw err
  }
}

let rawManifoldCtorCache = null

/**
 * The public `new Manifold(mesh)` constructs a solid, then throws on
 * `status !== 'NoError'` without deleting it. The embind constructor
 * still returns that solid so the failure path can free it.
 */
function rawManifoldCtor() {
  if (rawManifoldCtorCache) return rawManifoldCtorCache
  const { Manifold } = getWasm()
  const base = Object.getPrototypeOf(Manifold.prototype)
  const ctor = base?.constructor
  if (typeof ctor === 'function' && ctor !== Manifold) rawManifoldCtorCache = ctor
  return rawManifoldCtorCache
}

function allocCrossSection(contours, fillRule) {
  const { CrossSection } = getWasm()
  return trackWasm(new CrossSection(contours, fillRule))
}

function allocMesh(spec) {
  const { Mesh } = getWasm()
  return trackWasm(new Mesh(spec))
}

function allocManifoldFromMesh(mesh) {
  const Raw = rawManifoldCtor()
  const { Manifold } = getWasm()
  let solid = null
  try {
    solid = Raw ? new Raw(mesh) : new Manifold(mesh)
  } catch (err) {
    console.warn('[manifoldEngine] geometryToManifold failed:', err)
    return null
  }
  trackWasm(solid)
  let status = 'NoError'
  try {
    status = solid?.status?.() ?? 'InvalidConstruction'
  } catch {
    status = 'InvalidConstruction'
  }
  if (!solid || status !== 'NoError' || solid.isEmpty()) {
    if (status !== 'NoError') {
      console.warn('[manifoldEngine] geometryToManifold failed:', status)
    }
    wasmDelete(solid)
    return null
  }
  return solid
}

function makeCrossSection(paths, fillRule = 'NonZero') {
  const contours = toContours(paths)
  if (contours.length === 0) return null
  let cs = null
  try {
    cs = allocCrossSection(contours, fillRule)
  } catch (err) {
    console.warn('[manifoldEngine] CrossSection failed:', err)
    return null
  }
  if (!cs || cs.isEmpty()) {
    wasmDelete(cs)
    return null
  }
  return cs
}

/**
 * Native manifold-3d 2D offset. `CrossSection.offset` is the offsetter
 * that the same library's extrude consumes, so the outer wall and the
 * 3D solid stay in one numerical framework — no Clipper round-trip.
 *
 * JoinType values are the string literals the WASM wrapper's
 * `joinTypeToInt` actually compares against (`'Round'|'Miter'|'Square'`).
 */
export function offsetPathsManifold(paths, deltaMm, options = {}) {
  if (!paths || paths.length === 0 || Math.abs(deltaMm) < 0.0001) return paths
  const { joinType = 'Round', circularSegments = 128, miterLimit } = options
  const key = String(joinType).toLowerCase()
  let jt = 'Round'
  if (key === 'miter') jt = 'Miter'
  else if (key === 'square') jt = 'Square'

  // Manifold's default miterLimit is 2 (also the minimum). That squares any
  // corner sharper than ~60°. Callers that opt into Miter can raise the
  // limit; handles do not — they use the default Round join.
  const limit = miterLimit != null ? miterLimit : jt === 'Miter' ? 8 : 2.0

  let cs = null
  let offsetCs = null
  try {
    cs = makeCrossSection(paths, 'NonZero')
    if (!cs) return paths
    offsetCs = allocWasm(() => cs.offset(deltaMm, jt, limit, circularSegments))
    const polys = offsetCs.toPolygons()
    const result = []
    for (const poly of polys) {
      result.push(poly.map((pt) => ({ x: pt[0], y: pt[1] })))
    }
    return result
  } finally {
    wasmDelete(cs)
    wasmDelete(offsetCs)
  }
}

/**
 * Copies a manifold Mesh out of WASM memory into a standalone
 * THREE.BufferGeometry. Views into the WASM heap are NOT reused — the
 * heap can grow on a later allocation and invalidate them.
 */
export function manifoldToGeometry(solid, weldTolerance = 1e-4) {
  if (!solid || solid.isEmpty()) return null
  let mesh = null
  try {
    mesh = allocWasm(() => solid.getMesh())
    const numProp = mesh.numProp || 3
    const src = mesh.vertProperties
    const nverts = src.length / numProp
    if (nverts < 3 || !mesh.triVerts || mesh.triVerts.length < 3) return null

    const positions = new Float32Array(nverts * 3)
    for (let i = 0; i < nverts; i++) {
      const o = i * numProp
      positions[i * 3] = src[o]
      positions[i * 3 + 1] = src[o + 1]
      positions[i * 3 + 2] = src[o + 2]
    }
    const triVerts = new Uint32Array(mesh.triVerts)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(triVerts, 1))
    // `getMesh()` duplicates vertices wherever properties differ and records
    // the pairs in mergeFromVert / mergeToVert. Those pairs are bitwise-equal
    // positions. Weld on position only (no normal attribute yet) so a later
    // boolean can read this buffer back as a 2-manifold. The default 1e-4 mm
    // cell also snaps Manifold's seam slivers (stamp plate ∩ imprint wall);
    // callers that must keep those triangles pass a tighter tolerance.
    // Arrays above are copies; the mesh handle is released in `finally`.
    const welded = mergeVertices(geo, weldTolerance)
    if (welded !== geo) geo.dispose()
    // Boolean meshes occasionally emit the same face twice along a seam.
    // A duplicated pair makes one edge belong to four triangles; Cura flags
    // that as non-manifold even though the solid underneath is valid.
    dedupeTriangles(welded)
    dedupeCoincidentFaces(welded)
    welded.computeVertexNormals()
    return welded
  } finally {
    wasmDelete(mesh)
  }
}

/** Drops a second triangle that occupies the same three points. */
function dedupeCoincidentFaces(geo, eps = 1e-5) {
  const idx = geo.index
  const pos = geo.attributes?.position
  if (!idx || !pos) return geo
  const src = idx.array
  const quant = (v) => Math.round(v / eps)
  const seen = new Set()
  const kept = []
  for (let i = 0; i < src.length; i += 3) {
    const ids = [src[i], src[i + 1], src[i + 2]]
    const keys = ids.map((id) => `${quant(pos.getX(id))},${quant(pos.getY(id))},${quant(pos.getZ(id))}`)
    keys.sort()
    const key = keys.join('|')
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(ids[0], ids[1], ids[2])
  }
  if (kept.length !== src.length) {
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1))
  }
  return geo
}

function dedupeTriangles(geo) {
  const idx = geo.index
  const pos = geo.attributes?.position
  if (!idx || !pos) return geo
  const src = idx.array
  const seen = new Set()
  const kept = []
  for (let i = 0; i < src.length; i += 3) {
    const a = src[i]
    const b = src[i + 1]
    const c = src[i + 2]
    if (a === b || b === c || c === a) continue
    const ordered = [a, b, c].sort((x, y) => x - y)
    const key = `${ordered[0]},${ordered[1]},${ordered[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(a, b, c)
  }
  if (kept.length !== src.length) {
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1))
  }
  return geo
}

function unionResultOk(solid) {
  if (!solid) return false
  try {
    if (solid.isEmpty()) return false
    if (typeof solid.status === 'function' && solid.status() !== 'NoError') return false
  } catch {
    return false
  }
  return true
}

function forgetOwned(owned, solid) {
  if (!solid) return
  for (let i = 0; i < owned.length; i++) {
    if (owned[i] === solid) owned[i] = null
  }
}

/**
 * The stock `Manifold.union` / `difference` / `intersection` helper
 * allocates a `Vector_manifold` and only deletes it after the boolean
 * returns. A throw skips that delete. Reinstall the three ops so the
 * vector is freed on every exit. Operands stay owned by the caller.
 */
function hardenBatchBooleans(inst) {
  if (typeof inst?.Vector_manifold !== 'function') return
  const ops = [
    ['union', '_manifoldUnionN'],
    ['difference', '_manifoldDifferenceN'],
    ['intersection', '_manifoldIntersectionN'],
  ]
  for (const [name, fnName] of ops) {
    const native = inst[fnName]
    if (typeof native !== 'function') continue
    const safe = (...args) => {
      const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
      const vec = new inst.Vector_manifold()
      try {
        for (const manifold of list) {
          if (manifold) vec.push_back(manifold)
        }
        return native(vec)
      } finally {
        vec.delete()
      }
    }
    inst.Manifold[name] = safe
    if (name === 'union') inst.Manifold.compose = safe
  }
}

/**
 * One boolean. A throw, an empty result, or `status !== 'NoError'` deletes
 * the result and returns null. Operands are not consumed.
 */
function allocBoolean(kind, operands) {
  const { Manifold } = getWasm()
  const op = Manifold?.[kind]
  if (typeof op !== 'function') return null
  let result = null
  try {
    result = trackWasm(op(operands))
  } catch (err) {
    wasmDelete(result)
    console.warn(`[manifoldEngine] Manifold.${kind} failed:`, err)
    return null
  }
  if (!unionResultOk(result)) {
    wasmDelete(result)
    return null
  }
  return result
}

function adoptPair(survivor, operand) {
  const next = allocBoolean('union', [survivor, operand])
  if (!next) return { survivor, consumed: false }
  return { survivor: next, consumed: true, previous: survivor }
}

function unionSolids(solids) {
  const owned = []
  for (const s of solids || []) {
    if (!s) continue
    if (!unionResultOk(s)) {
      wasmDelete(s)
      continue
    }
    owned.push(s)
  }
  if (owned.length === 0) return null
  if (owned.length === 1) return owned[0]

  let survivor = null
  try {
    survivor = allocBoolean('union', owned)
    if (!survivor) {
      survivor = owned[0]
      for (let i = 1; i < owned.length; i++) {
        const operand = owned[i]
        const reduced = adoptPair(survivor, operand)
        if (reduced.consumed) {
          survivor = reduced.survivor
          forgetOwned(owned, reduced.previous)
          wasmDelete(reduced.previous)
          forgetOwned(owned, operand)
          wasmDelete(operand)
        } else {
          forgetOwned(owned, operand)
          wasmDelete(operand)
        }
      }
    }
    if (!unionResultOk(survivor)) {
      forgetOwned(owned, survivor)
      wasmDelete(survivor)
      survivor = null
      return null
    }
    return survivor
  } finally {
    for (const s of owned) {
      if (s && s !== survivor) wasmDelete(s)
    }
  }
}

function extrudeRingSolid(innerCS, outerPaths, height, nDivisions) {
  let outerCS = null
  let ring = null
  let solid = null
  try {
    outerCS = makeCrossSection(outerPaths)
    if (!outerCS) return null
    ring = allocWasm(() => outerCS.subtract(innerCS))
    wasmDelete(outerCS)
    outerCS = null
    if (!ring || ring.isEmpty()) return null
    solid = allocWasm(() => ring.extrude(height, nDivisions))
    wasmDelete(ring)
    ring = null
    if (!solid || solid.isEmpty()) return null
    const out = solid
    solid = null
    return out
  } finally {
    wasmDelete(outerCS)
    wasmDelete(ring)
    wasmDelete(solid)
  }
}

function stripHorizontalCap(geo, z, tolerance = 2e-4) {
  if (!geo || !geo.index) return geo
  const pos = geo.attributes.position
  const idx = geo.index.array
  const kept = []
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i]
    const i1 = idx[i + 1]
    const i2 = idx[i + 2]
    const z0 = pos.getZ(i0)
    const z1 = pos.getZ(i1)
    const z2 = pos.getZ(i2)
    if (Math.abs(z0 - z) < tolerance && Math.abs(z1 - z) < tolerance && Math.abs(z2 - z) < tolerance) {
      continue
    }
    kept.push(i0, i1, i2)
  }
  if (kept.length < 3 || kept.length === idx.length) return geo
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1))
  geo.computeVertexNormals()
  return geo
}

/**
 * Extrude a set of closed 2D loops (outers + holes, NonZero fill) into a
 * watertight solid.
 */
export function extrudePaths(paths, height, options = {}) {
  const { z0 = 0, nDivisions = 0 } = options
  if (!paths || paths.length === 0 || !(height > 0.001)) return null

  let cs = null
  let solid = null
  try {
    cs = makeCrossSection(paths)
    if (!cs) return null
    solid = allocWasm(() => cs.extrude(height, nDivisions))
    wasmDelete(cs)
    cs = null
    if (!solid || solid.isEmpty()) return null
    if (Math.abs(z0) > 1e-9) {
      const moved = allocWasm(() => solid.translate([0, 0, z0]))
      wasmDelete(solid)
      solid = moved
    }
    const geo = manifoldToGeometry(solid)
    wasmDelete(solid)
    solid = null
    return geo
  } catch (err) {
    console.error('[manifoldEngine] extrudePaths failed:', err)
    return null
  } finally {
    wasmDelete(cs)
    wasmDelete(solid)
  }
}

/**
 * Extrude several 2D fills and fuse them into one watertight solid.
 * Adjacent volumes should overlap slightly on Z so coplanar caps merge
 * instead of z-fighting (stamp plate + raised imprint).
 */
export function extrudeAndUnion(parts, options = {}) {
  const { weldTolerance = 1e-4 } = options
  const solids = []
  let merged = null
  let cs = null
  let solid = null
  try {
    for (const part of parts || []) {
      const { paths, height, z0 = 0, nDivisions = 0 } = part || {}
      if (!paths || paths.length === 0 || !(height > 0.001)) continue
      cs = makeCrossSection(paths)
      if (!cs) continue
      solid = allocWasm(() => cs.extrude(height, nDivisions))
      wasmDelete(cs)
      cs = null
      if (!solid || solid.isEmpty()) {
        wasmDelete(solid)
        solid = null
        continue
      }
      if (Math.abs(z0) > 1e-9) {
        const moved = allocWasm(() => solid.translate([0, 0, z0]))
        wasmDelete(solid)
        solid = moved
      }
      solids.push(solid)
      solid = null
    }
    merged = unionSolids(solids)
    solids.length = 0
    if (!merged) return null
    const geo = manifoldToGeometry(merged, weldTolerance)
    wasmDelete(merged)
    merged = null
    return geo
  } catch (err) {
    console.error('[manifoldEngine] extrudeAndUnion failed:', err)
    return null
  } finally {
    wasmDelete(cs)
    wasmDelete(solid)
    for (const s of solids) wasmDelete(s)
    wasmDelete(merged)
  }
}

/**
 * Extrude `outerPaths` minus `innerPaths` as a hollow ring.
 */
export function extrudeRing(outerPaths, innerPaths, height, options = {}) {
  const { z0 = 0, nDivisions = 0, openBottom = false, openTop = false } = options
  if (!outerPaths || outerPaths.length === 0 || !(height > 0.001)) return null

  let outerCS = null
  let innerCS = null
  let ring = null
  let solid = null
  try {
    outerCS = makeCrossSection(outerPaths)
    if (!outerCS) return null
    innerCS = innerPaths && innerPaths.length > 0 ? makeCrossSection(innerPaths) : null

    if (innerCS) {
      ring = allocWasm(() => outerCS.subtract(innerCS))
      wasmDelete(outerCS)
      outerCS = null
      wasmDelete(innerCS)
      innerCS = null
    } else {
      ring = outerCS
      outerCS = null
    }
    if (!ring || ring.isEmpty()) return null

    solid = allocWasm(() => ring.extrude(height, nDivisions))
    wasmDelete(ring)
    ring = null
    if (!solid || solid.isEmpty()) return null
    if (Math.abs(z0) > 1e-9) {
      const moved = allocWasm(() => solid.translate([0, 0, z0]))
      wasmDelete(solid)
      solid = moved
    }
    const geo = manifoldToGeometry(solid)
    wasmDelete(solid)
    solid = null
    if (!geo) return null
    if (openBottom) stripHorizontalCap(geo, z0)
    if (openTop) stripHorizontalCap(geo, z0 + height)
    return geo
  } catch (err) {
    console.error('[manifoldEngine] extrudeRing failed:', err)
    return null
  } finally {
    wasmDelete(outerCS)
    wasmDelete(innerCS)
    wasmDelete(ring)
    wasmDelete(solid)
  }
}

const LOFT_DEDUPE_EPS_MM = 1e-6
const LOFT_DEGENERATE_AREA2 = 1e-16

function dedupeClosedLoop(loop, eps = LOFT_DEDUPE_EPS_MM) {
  const out = []
  for (const p of loop || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > eps) out.push({ x: p.x, y: p.y })
  }
  if (out.length > 1) {
    const a = out[0]
    const b = out[out.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) out.pop()
  }
  return out
}

function loopArea(loop) {
  let area = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

/** `ccw === true` keeps a positive-area walk. Hole walls pass `false`. */
function orientLoop(loop, ccw) {
  const positive = loopArea(loop) > 0
  if (positive === ccw) return loop
  return loop.slice().reverse()
}

function dist2xy(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/**
 * Normalized arc-length along `loop`, rotated so parameter 0 is `origin`.
 * `u[k]` is the fraction of the perimeter consumed by the first k edges
 * (`u[0] === 0`, `u[n] === 1`). Returns null when the perimeter is
 * degenerate so the stitch can fall back to index proportion.
 */
function normalizedArcProgress(loop, origin) {
  const n = loop.length
  const cum = new Float64Array(n + 1)
  for (let k = 0; k < n; k++) {
    const a = loop[(origin + k) % n]
    const b = loop[(origin + k + 1) % n]
    cum[k + 1] = cum[k] + Math.hypot(b.x - a.x, b.y - a.y)
  }
  const total = cum[n]
  if (!(total > 1e-12)) return null
  const u = new Float64Array(n + 1)
  for (let k = 0; k <= n; k++) u[k] = cum[k] / total
  return u
}

function extremeIndex(loop) {
  let best = 0
  for (let i = 1; i < loop.length; i++) {
    const p = loop[i]
    const q = loop[best]
    if (p.x < q.x - 1e-9 || (Math.abs(p.x - q.x) <= 1e-9 && p.y < q.y)) best = i
  }
  return best
}

function classifyLoops(paths) {
  const outers = []
  const holes = []
  for (const loop of paths || []) {
    const clean = dedupeClosedLoop(loop)
    if (clean.length < 3) continue
    const area = loopArea(clean)
    if (!(Math.abs(area) > 1e-8)) continue
    if (area > 0) outers.push(clean)
    else holes.push(clean)
  }
  return { outers, holes }
}

function pairLoops(aLoops, bLoops) {
  if (aLoops.length !== bLoops.length) return null
  if (aLoops.length === 0) return []
  const used = new Set()
  const pairs = []
  for (const a of aLoops) {
    let ax = 0
    let ay = 0
    for (const p of a) {
      ax += p.x
      ay += p.y
    }
    ax /= a.length
    ay /= a.length
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < bLoops.length; i++) {
      if (used.has(i)) continue
      const b = bLoops[i]
      let bx = 0
      let by = 0
      for (const p of b) {
        bx += p.x
        by += p.y
      }
      bx /= b.length
      by /= b.length
      const d = (ax - bx) * (ax - bx) + (ay - by) * (ay - by)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) return null
    used.add(best)
    pairs.push([a, bLoops[best]])
  }
  return pairs
}

/**
 * Ruled quad-strip between two closed contours (skinning).
 *
 * Both loops must already share a winding. CCW (positive area) makes the
 * strip face outward: triangle (b_i, b_{i+1}, t_j) / (b_i, t_{j+1}, t_j).
 * CW makes the same construction face into the hole. The stitch advances
 * whichever contour is trailing in normalized arc length, so the ruled
 * edges stay parallel to the contours. A V-notch cannot pull a diagonal
 * across the gap. Equal progress advances the bottom contour, so a
 * vertical wall (identical loops) becomes quads instead of a fan.
 *
 * Returns an indexed BufferGeometry with position only, or null.
 */
export function loftPolygons(bottomLoop, topLoop, zBottom, zTop) {
  const bottom = dedupeClosedLoop(bottomLoop)
  const top = dedupeClosedLoop(topLoop)
  if (bottom.length < 3 || top.length < 3) return null
  if (!Number.isFinite(zBottom) || !Number.isFinite(zTop)) return null

  const n = bottom.length
  const m = top.length
  const bOrigin = extremeIndex(bottom)
  const anchor = bottom[bOrigin]
  let tOrigin = 0
  let bestD = Infinity
  for (let j = 0; j < m; j++) {
    const d = dist2xy(anchor, top[j])
    if (d < bestD) {
      bestD = d
      tOrigin = j
    }
  }

  const positions = new Float32Array((n + m) * 3)
  for (let i = 0; i < n; i++) {
    const p = bottom[(bOrigin + i) % n]
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = zBottom
  }
  for (let j = 0; j < m; j++) {
    const p = top[(tOrigin + j) % m]
    const o = (n + j) * 3
    positions[o] = p.x
    positions[o + 1] = p.y
    positions[o + 2] = zTop
  }

  const uBottom = normalizedArcProgress(bottom, bOrigin)
  const uTop = normalizedArcProgress(top, tOrigin)

  const indexList = []
  let i = 0
  let j = 0
  const guard = n + m + 2
  let steps = 0
  while ((i < n || j < m) && steps < guard) {
    steps++
    const i0 = i % n
    const j0 = j % m
    const i1 = (i + 1) % n
    const j1 = (j + 1) % m
    const canB = i < n
    const canT = j < m
    let advanceB
    if (!canT) advanceB = true
    else if (!canB) advanceB = false
    else if (uBottom && uTop) advanceB = uBottom[i] <= uTop[j]
    else advanceB = i / n <= j / m

    if (advanceB) {
      indexList.push(i0, i1, n + j0)
      i++
    } else {
      indexList.push(i0, n + j1, n + j0)
      j++
    }
  }
  if (i !== n || j !== m || indexList.length < 3) return null

  const kept = []
  for (let t = 0; t < indexList.length; t += 3) {
    const ia = indexList[t]
    const ib = indexList[t + 1]
    const ic = indexList[t + 2]
    const ax = positions[ia * 3]
    const ay = positions[ia * 3 + 1]
    const az = positions[ia * 3 + 2]
    const bx = positions[ib * 3]
    const by = positions[ib * 3 + 1]
    const bz = positions[ib * 3 + 2]
    const cx = positions[ic * 3]
    const cy = positions[ic * 3 + 1]
    const cz = positions[ic * 3 + 2]
    const abx = bx - ax
    const aby = by - ay
    const abz = bz - az
    const acx = cx - ax
    const acy = cy - ay
    const acz = cz - az
    const crx = aby * acz - abz * acy
    const cry = abz * acx - abx * acz
    const crz = abx * acy - aby * acx
    if (crx * crx + cry * cry + crz * crz < LOFT_DEGENERATE_AREA2) continue
    kept.push(ia, ib, ic)
  }
  if (kept.length < 3) return null

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1))
  return geo
}

function pushLoft(parts, bottom, top, z0, z1, ccw) {
  const geo = loftPolygons(orientLoop(bottom, ccw), orientLoop(top, ccw), z0, z1)
  if (!geo) return false
  parts.push(geo)
  return true
}

/**
 * One indexed shell. Normals are stripped before the weld so
 * `mergeVertices` hashes position only — otherwise coincident corners
 * of the loft, the cavity wall, and the caps stay split and the shell
 * is open.
 */
function weldClosedShell(parts) {
  const valid = parts.filter((g) => g?.getAttribute?.('position')?.count >= 3)
  if (valid.length === 0) return null
  for (const g of valid) {
    g.deleteAttribute('normal')
    g.deleteAttribute('uv')
  }
  const merged = valid.length === 1 ? valid[0] : mergeBufferGeometries(valid, false)
  if (!merged?.getAttribute?.('position')) return null
  merged.deleteAttribute('normal')
  const welded = mergeVertices(merged, 1e-4)
  if (merged !== welded && !valid.includes(merged)) merged.dispose()
  welded.computeVertexNormals()
  return welded
}

/**
 * Cutter wall as one closed shell. The outer boundary is a
 * `CrossSection.offset` of the 1:1 cavity sampled at each `levels` entry
 * and skinned with `loftPolygons` — a sloped quad strip, not a stack of
 * flat prisms. The cavity itself is a straight vertical wall. Top and
 * bottom are `triangulateRingCap` annuli.
 *
 * Negative-area loops are windows. The same offset shrinks those holes,
 * so each window grows its own double-sided wall. Caps cover the outer
 * lip and the ring between the traced hole and its shrunk offset. The
 * open window stays empty.
 *
 * Same-Z shoulders (rectangular handle stepping inward onto the blade
 * wall) are not lofted; the cap is the full annulus at the last Z that
 * actually changes. The caller boolean-unions this closed solid with the
 * blade, which consumes the shared interior face.
 */
export function extrudeOffsetProfile(cavityPaths, levels, getOuterPaths, options = {}) {
  const { capAtStart = true, capAtEnd = true } = options
  if (!cavityPaths || cavityPaths.length === 0 || !levels || levels.length < 2) return null

  const cavity = []
  for (const loop of cavityPaths) {
    const clean = dedupeClosedLoop(loop)
    if (clean.length < 3) continue
    if (!(Math.abs(loopArea(clean)) > 1e-8)) continue
    cavity.push(clean)
  }
  if (cavity.length === 0) return null

  const rings = []
  for (const level of levels) {
    if (!level || !Number.isFinite(level.z) || !Number.isFinite(level.offset)) return null
    if (!(level.offset > 1e-4)) return null
    const split = classifyLoops(getOuterPaths(level.offset))
    if (split.outers.length === 0) return null
    const prev = rings[rings.length - 1]
    if (prev && Math.abs(level.z - prev.z) < 1e-4) continue
    rings.push({ z: level.z, outers: split.outers, holes: split.holes })
  }
  if (rings.length < 2) return null

  const z0 = rings[0].z
  const z1 = rings[rings.length - 1].z
  if (!(z1 - z0 > 0.001)) return null

  const parts = []
  let welded = null
  try {
    for (let s = 0; s < rings.length - 1; s++) {
      const a = rings[s]
      const b = rings[s + 1]
      if (!(b.z > a.z + 1e-6)) continue
      const outers = pairLoops(a.outers, b.outers)
      const holes = pairLoops(a.holes, b.holes)
      if (!outers || !holes) return null
      for (const [bottom, top] of outers) {
        if (!pushLoft(parts, bottom, top, a.z, b.z, true)) return null
      }
      for (const [bottom, top] of holes) {
        if (!pushLoft(parts, bottom, top, a.z, b.z, false)) return null
      }
    }

    // Positive loops are the outer cutting edge: the wall sits outside
    // them, so the face points into the dough. Negative loops are windows:
    // positive offset shrinks the hole, so the wall sits inside the loop
    // and this face points back out into the dough.
    const cavityOuters = []
    const cavityHoles = []
    for (const loop of cavity) {
      if (loopArea(loop) > 0) cavityOuters.push(loop)
      else cavityHoles.push(loop)
    }
    for (const loop of cavityOuters) {
      if (!pushLoft(parts, loop, loop, z0, z1, false)) return null
    }
    for (const loop of cavityHoles) {
      if (!pushLoft(parts, loop, loop, z0, z1, true)) return null
    }

    // No windows: outers are the offset contour, holes are the traced
    // cavity (plus any offset holes). With windows, each traced hole is
    // an island inside that cavity hole, and the shrunk offset hole is
    // the island's opening — so both annuli fill and the window stays empty.
    const ringCap = (ring, z, faceDown) =>
      triangulateRingCap(
        [...ring.outers, ...cavityHoles],
        [...cavityOuters, ...ring.holes],
        z,
        faceDown,
      )

    if (capAtStart) {
      const cap = ringCap(rings[0], z0, true)
      if (!cap) return null
      parts.push(cap)
    }
    if (capAtEnd) {
      const cap = ringCap(rings[rings.length - 1], z1, false)
      if (!cap) return null
      parts.push(cap)
    }

    welded = weldClosedShell(parts)
    return welded
  } catch (err) {
    console.error('[manifoldEngine] extrudeOffsetProfile failed:', err)
    return null
  } finally {
    for (const g of parts) {
      if (g && g !== welded) g.dispose()
    }
  }
}

/**
 * Convert a THREE.BufferGeometry into a manifold-3d solid. Positions are
 * copied off the Three.js arrays so later WASM heap growth cannot
 * invalidate them. Returns null (and never throws) if the mesh is empty
 * or not a 2-manifold — callers fall back to a plain merge.
 */
/**
 * Boolean-assemble a straight chamfer onto the vertical blade wall.
 *
 * `chamferGeo` is a closed solid loft of the outer contours (cavity still
 * filled in). The cavity prism is subtracted so the cutting edge stays the
 * 1:1 trace, then the hollow chamfer is unioned with a closed vertical ring.
 * Both booleans stay in manifold-3d. The bottom cap is always kept: the
 * handle is a separate closed solid and is boolean-unioned afterwards.
 * Stripping this cap leaves an open shell, which Cura rejects.
 *
 * Returns a THREE.BufferGeometry, or null if any solid is empty.
 */
export function assembleChamferedBlade({
  cavityPaths,
  verticalOuterPaths,
  verticalHeight,
  chamferGeo,
  chamferZ0,
  chamferZ1,
}) {
  if (!(verticalHeight > 0.001) || !(chamferZ1 > chamferZ0)) return null

  let innerCS = null
  let vertical = null
  let chamfer = null
  let cutterCS = null
  let cutter = null
  let hollow = null
  let merged = null
  try {
    innerCS = makeCrossSection(cavityPaths)
    if (!innerCS) return null
    vertical = extrudeRingSolid(innerCS, verticalOuterPaths, verticalHeight, 0)
    wasmDelete(innerCS)
    innerCS = null
    if (!vertical) return null

    chamfer = geometryToManifold(chamferGeo)
    if (!chamfer) return null

    const pad = 0.05
    cutterCS = makeCrossSection(cavityPaths)
    if (!cutterCS) return null
    cutter = allocWasm(() => cutterCS.extrude(chamferZ1 - chamferZ0 + pad * 2, 0))
    wasmDelete(cutterCS)
    cutterCS = null
    if (!cutter || cutter.isEmpty()) return null
    const z0 = chamferZ0 - pad
    if (Math.abs(z0) > 1e-9) {
      const moved = allocWasm(() => cutter.translate([0, 0, z0]))
      wasmDelete(cutter)
      cutter = moved
    }

    hollow = allocBoolean('difference', [chamfer, cutter])
    wasmDelete(chamfer)
    chamfer = null
    wasmDelete(cutter)
    cutter = null
    if (!hollow) return null

    merged = allocBoolean('union', [vertical, hollow])
    wasmDelete(vertical)
    vertical = null
    wasmDelete(hollow)
    hollow = null
    if (!merged || merged.isEmpty()) return null

    const geo = manifoldToGeometry(merged)
    wasmDelete(merged)
    merged = null
    return geo
  } catch (err) {
    console.warn('[manifoldEngine] assembleChamferedBlade failed:', err)
    return null
  } finally {
    wasmDelete(innerCS)
    wasmDelete(vertical)
    wasmDelete(chamfer)
    wasmDelete(cutterCS)
    wasmDelete(cutter)
    wasmDelete(hollow)
    wasmDelete(merged)
  }
}

/**
 * Validate a closed blade shell in manifold-3d and copy the solid back out.
 * The bottom cap is always kept. Opening it used to avoid a coplanar face
 * against the handle; the assembly now boolean-unions the two closed solids
 * instead, so an open blade shell is never emitted.
 */
export function shellToBladeGeometry(geo) {
  let solid = null
  try {
    solid = geometryToManifold(geo)
    if (!solid || solid.isEmpty() || solid.status() !== 'NoError') return null
    if (!(solid.volume() > 0)) return null
    const out = manifoldToGeometry(solid)
    wasmDelete(solid)
    solid = null
    return out
  } catch (err) {
    console.warn('[manifoldEngine] shellToBladeGeometry failed:', err)
    return null
  } finally {
    wasmDelete(solid)
  }
}

/**
 * Position-only weld. Non-indexed extrusions and creased-normal meshes
 * duplicate corners that occupy the same point; Manifold treats those as
 * open edges unless they are one vertex.
 */
function weldPositions(geo) {
  const copy = geo.clone()
  for (const name of Object.keys(copy.attributes)) {
    if (name !== 'position') copy.deleteAttribute(name)
  }
  const welded = mergeVertices(copy, 1e-4)
  if (welded !== copy) copy.dispose()
  return welded
}

export function geometryToManifold(geo) {
  if (!geo || !geo.attributes?.position) return null
  const welded = weldPositions(geo)
  const positions = new Float32Array(welded.attributes.position.array)
  const nverts = positions.length / 3
  if (nverts < 3) {
    welded.dispose()
    return null
  }

  let triVerts
  if (welded.index) {
    const src = welded.index.array
    triVerts = src instanceof Uint32Array ? new Uint32Array(src) : Uint32Array.from(src)
  } else {
    triVerts = new Uint32Array(nverts)
    for (let i = 0; i < nverts; i++) triVerts[i] = i
  }
  welded.dispose()
  if (triVerts.length < 3) return null

  let mesh = null
  let solid = null
  try {
    mesh = allocMesh({ numProp: 3, vertProperties: positions, triVerts })
    solid = allocManifoldFromMesh(mesh)
    if (!solid) return null
    const out = solid
    solid = null
    return out
  } catch (err) {
    console.warn('[manifoldEngine] geometryToManifold failed:', err)
    return null
  } finally {
    wasmDelete(mesh)
    wasmDelete(solid)
  }
}

/**
 * Watertight boolean union of TWO BufferGeometries via manifold-3d.
 * Replaces three-bvh-csg. Both inputs are converted, unioned, and every
 * WASM handle is deleted before return.
 */
export function unionBufferGeometries(a, b) {
  if (!a) return b
  if (!b) return a
  let sa = null
  let sb = null
  let merged = null
  let cleaned = null
  try {
    sa = geometryToManifold(a)
    sb = geometryToManifold(b)
    if (!sa || !sb) return null
    merged = allocBoolean('union', [sa, sb])
    wasmDelete(sa)
    wasmDelete(sb)
    sa = null
    sb = null
    if (!merged) return null
    // getMesh() can leave one seam edge shared by four triangles even when
    // the solid is valid. Re-importing asks Manifold to emit the cleaned
    // triangulation (it drops the duplicate pair) before we copy it out.
    let geo = manifoldToGeometry(merged)
    wasmDelete(merged)
    merged = null
    if (!geo) return null
    cleaned = geometryToManifold(geo)
    if (!cleaned) return geo
    const out = manifoldToGeometry(cleaned)
    wasmDelete(cleaned)
    cleaned = null
    if (!out) return geo
    geo.dispose()
    return out
  } catch (err) {
    console.error('[manifoldEngine] unionBufferGeometries failed:', err)
    return null
  } finally {
    wasmDelete(sa)
    wasmDelete(sb)
    wasmDelete(merged)
    wasmDelete(cleaned)
  }
}

/**
 * Planar ring cap triangulated by manifold's constrained triangulator.
 */
function triangulateRingCap(outerPaths, innerPaths, z, faceDown) {
  const wasmHandle = getWasm()
  const polygons = []
  const verts = []

  const pushLoop = (loop, asHole) => {
    if (!loop || loop.length < 3) return
    const contour = loop.map((p) => [p.x, p.y])
    const cw = signedAreaXY(contour) < 0
    if (asHole !== cw) contour.reverse()
    polygons.push(contour)
    for (const p of contour) verts.push(p)
  }

  for (const loop of outerPaths || []) pushLoop(loop, false)
  for (const loop of innerPaths || []) pushLoop(loop, true)
  if (polygons.length === 0 || verts.length < 3) return null

  let tris
  try {
    tris = wasmHandle.triangulate(polygons)
  } catch (err) {
    console.error('[manifoldEngine] triangulateRingCap failed:', err)
    return null
  }
  if (!tris || tris.length === 0) return null

  const positions = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i][0]
    positions[i * 3 + 1] = verts[i][1]
    positions[i * 3 + 2] = z
  }

  const indices = new Uint32Array(tris.length * 3)
  const flip = Boolean(faceDown)
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i]
    const o = i * 3
    if (flip) {
      indices[o] = t[0]
      indices[o + 1] = t[2]
      indices[o + 2] = t[1]
    } else {
      indices[o] = t[0]
      indices[o + 1] = t[1]
      indices[o + 2] = t[2]
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  geo.computeVertexNormals()
  return geo
}

// LED sleeve seated on the floor. The side slit is the wire path; the floor
// under the pillar stays closed.
const LIGHTBOX_LED_OUTER_RADIUS_MM = 4
const LIGHTBOX_LED_INNER_RADIUS_MM = 2.6
const LIGHTBOX_LED_HEIGHT_MM = 12
const LIGHTBOX_LED_SEGMENTS = 64
const LIGHTBOX_SLIT_WIDTH_MM = 2.4
// 2×AAA block. Long axis runs along Y, tucked into the back-right corner.
const LIGHTBOX_BATTERY_LENGTH_MM = 53
const LIGHTBOX_BATTERY_WIDTH_MM = 25
const LIGHTBOX_BATTERY_BLOCK_HEIGHT_MM = 8
const LIGHTBOX_BATTERY_MARGIN_MM = 2.5
const LIGHTBOX_WIRE_RADIUS_MM = 1.15
const LIGHTBOX_WIRE_SPACING_MM = 16
const LIGHTBOX_PILLAR_CLEARANCE_MM = 3
// Rim lip above the plate. Total outer face is this tall, not `boxDepth`.
const LIGHTBOX_RIM_HEIGHT_MM = 12
const LIGHTBOX_NOTCH_WIDTH_MM = 5
const LIGHTBOX_CENTER_NOTCH_WIDTH_MM = 8
const LIGHTBOX_SCREW_RADIUS_MM = 1.15
const LIGHTBOX_SWITCH_WIDTH_MM = 13
const LIGHTBOX_SWITCH_HEIGHT_MM = 7
const LIGHTBOX_KEY_RADIUS_MM = 3.4
const LIGHTBOX_KEY_SLOT_WIDTH_MM = 2.8
const LIGHTBOX_KEY_SLOT_LENGTH_MM = 6
// Adjacent CSG slices overlap on Z so the union cannot leave a coplanar gap.
const LIGHTBOX_STACK_OVERLAP_MM = 0.01
// Cutters extend this far past each face they must open.
const LIGHTBOX_THROUGH_PAD_MM = 0.2

function lightboxMm(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function lightboxPartEnabled(settings, key) {
  return settings?.exportParts?.[key] !== false
}

function shiftSolid(solid, xyz) {
  if (!solid) return null
  const moved = allocWasm(() => solid.translate(xyz))
  wasmDelete(solid)
  return moved
}

function cutSolid(target, cutter) {
  if (!cutter) return target
  if (!target) {
    wasmDelete(cutter)
    return null
  }
  const next = allocBoolean('difference', [target, cutter])
  wasmDelete(cutter)
  if (!next) return target
  wasmDelete(target)
  return next
}

function solidToGeo(solid) {
  if (!solid) return null
  try {
    if (typeof solid.isEmpty === 'function' && solid.isEmpty()) return null
    return manifoldToGeometry(solid)
  } finally {
    wasmDelete(solid)
  }
}

/**
 * Hollow cylinder along +Z, base at z = 0. The inner cutter is taller than
 * the tube so both end caps are opened.
 */
function tubeSolid(height, outerR, innerR, segments) {
  if (!(height > 0.05) || !(outerR > innerR + 0.05) || !(innerR > 0)) return null
  const { Manifold } = getWasm()
  const pad = LIGHTBOX_THROUGH_PAD_MM
  let outer = null
  let inner = null
  try {
    outer = allocWasm(() => Manifold.cylinder(height, outerR, outerR, segments, false))
    inner = allocWasm(() => Manifold.cylinder(height + pad * 2, innerR, innerR, segments, false))
    inner = shiftSolid(inner, [0, 0, -pad])
    const tube = cutSolid(outer, inner)
    outer = null
    inner = null
    return tube
  } finally {
    wasmDelete(outer)
    wasmDelete(inner)
  }
}

function centeredCube(size, xyz) {
  if (size.some((v) => !(v > 0.05))) return null
  const { Manifold } = getWasm()
  let box = allocWasm(() => Manifold.cube(size, true))
  try {
    const moved = shiftSolid(box, xyz)
    box = null
    return moved
  } finally {
    wasmDelete(box)
  }
}

/**
 * Cylinder centered on `xyz`. `axis` 'x' or 'y' turns the Z-aligned
 * primitive. +90° about Y sends +Z to +X. −90° about X sends +Z to +Y.
 */
function centeredCylinder(height, radius, segments, axis, xyz) {
  if (!(height > 0.05) || !(radius > 0.05)) return null
  const { Manifold } = getWasm()
  let solid = allocWasm(() => Manifold.cylinder(height, radius, radius, segments, true))
  try {
    if (axis === 'x' || axis === 'y') {
      const angles = axis === 'x' ? [0, 90, 0] : [-90, 0, 0]
      const turned = allocWasm(() => solid.rotate(angles))
      wasmDelete(solid)
      solid = turned
    }
    const moved = shiftSolid(solid, xyz)
    solid = null
    return moved
  } finally {
    wasmDelete(solid)
  }
}

function claimSpan(center, half, blockers, limit) {
  if (!(half > 0) || Math.abs(center) + half > limit) return false
  const gap = 2.2
  if (blockers.some((b) => Math.abs(center - b.center) < half + b.half + gap)) return false
  blockers.push({ center, half })
  return true
}

/** Front rim, left to right: center joint groove, rocker window, screw holes. */
function frontRimLayout(width) {
  const limit = width / 2 - 1.2
  const blockers = []
  const notches = []
  if (claimSpan(0, LIGHTBOX_CENTER_NOTCH_WIDTH_MM / 2, blockers, limit)) notches.push(0)

  let switchX = null
  const preferred = width * 0.18
  if (claimSpan(preferred, LIGHTBOX_SWITCH_WIDTH_MM / 2, blockers, limit)) switchX = preferred

  const screws = []
  for (const x of [-width * 0.32, width * 0.38]) {
    if (claimSpan(x, LIGHTBOX_SCREW_RADIUS_MM, blockers, limit)) screws.push(x)
  }
  return { notches, switchX, screws }
}

function backRimLayout(width) {
  const limit = width / 2 - 1.2
  const blockers = []
  const notches = []
  for (const x of [-width * 0.3, width * 0.3]) {
    if (claimSpan(x, LIGHTBOX_NOTCH_WIDTH_MM / 2, blockers, limit)) notches.push(x)
  }
  const screws = []
  for (const x of [-width * 0.12, width * 0.12]) {
    if (claimSpan(x, LIGHTBOX_SCREW_RADIUS_MM, blockers, limit)) screws.push(x)
  }
  return { notches, screws }
}

function sideRimLayout(span) {
  const limit = span / 2 - 1.2
  const blockers = []
  const notches = []
  if (claimSpan(0, LIGHTBOX_NOTCH_WIDTH_MM / 2, blockers, limit)) notches.push(0)
  const screws = []
  for (const at of [-span * 0.32, span * 0.32]) {
    if (claimSpan(at, LIGHTBOX_SCREW_RADIUS_MM, blockers, limit)) screws.push(at)
  }
  return { notches, screws }
}

/**
 * Vertical joint groove in an outer rim face. Depth is half the wall
 * thickness. The cutter opens the outer face, the top, and the bottom,
 * and stops on the mid-plane so the inner half of the rim stays.
 */
function faceNotchX(x, notchW, outerY, intoPositiveY, wallT, rimH) {
  const pad = LIGHTBOX_THROUGH_PAD_MM
  const depth = wallT / 2
  const y0 = intoPositiveY ? outerY - pad : outerY - depth
  const y1 = intoPositiveY ? outerY + depth : outerY + pad
  return centeredCube([notchW, y1 - y0, rimH + pad * 2], [x, (y0 + y1) / 2, rimH / 2])
}

function faceNotchY(y, notchW, outerX, intoPositiveX, wallT, rimH) {
  const pad = LIGHTBOX_THROUGH_PAD_MM
  const depth = wallT / 2
  const x0 = intoPositiveX ? outerX - pad : outerX - depth
  const x1 = intoPositiveX ? outerX + depth : outerX + pad
  return centeredCube([x1 - x0, notchW, rimH + pad * 2], [(x0 + x1) / 2, y, rimH / 2])
}

function rimScrew(axis, x, y, wallT, rimH) {
  const pad = LIGHTBOX_THROUGH_PAD_MM
  return centeredCylinder(
    wallT + pad * 2,
    LIGHTBOX_SCREW_RADIUS_MM,
    28,
    axis,
    [x, y, rimH / 2],
  )
}

function switchCutter(x, boxHeight, wallT, rimH) {
  const pad = LIGHTBOX_THROUGH_PAD_MM
  const windowH = Math.min(LIGHTBOX_SWITCH_HEIGHT_MM, rimH - 4.5)
  if (!(windowH > 1.5)) return null
  const y0 = -boxHeight / 2 - pad
  const y1 = -boxHeight / 2 + wallT + pad
  return centeredCube(
    [LIGHTBOX_SWITCH_WIDTH_MM, y1 - y0, windowH],
    [x, (y0 + y1) / 2, rimH / 2],
  )
}

/**
 * 2×AAA block in the back-right corner. Null when it would cross the
 * pillar or leave the inner floor.
 */
function batteryPlacement(width, height, wallT) {
  const hx = LIGHTBOX_BATTERY_WIDTH_MM / 2
  const hy = LIGHTBOX_BATTERY_LENGTH_MM / 2
  const margin = LIGHTBOX_BATTERY_MARGIN_MM
  const maxX = width / 2 - wallT - margin
  const maxY = height / 2 - wallT - margin
  const minX = -width / 2 + wallT + margin
  const minY = -height / 2 + wallT + margin
  if (hx * 2 + 1 > maxX - minX || hy * 2 + 1 > maxY - minY) return null
  const cx = maxX - hx
  const cy = maxY - hy
  if (cx - hx < minX || cy - hy < minY) return null
  const dx = cx > hx ? cx - hx : cx < -hx ? cx + hx : 0
  const dy = cy > hy ? cy - hy : cy < -hy ? cy + hy : 0
  if (Math.hypot(dx, dy) < LIGHTBOX_LED_OUTER_RADIUS_MM + LIGHTBOX_PILLAR_CLEARANCE_MM) return null
  return { cx, cy, hx, hy }
}

/** Teardrop keyhole on the left of the floor. Slot runs toward −X. */
function keyholePlacement(width, height, wallT, battery) {
  const r = LIGHTBOX_KEY_RADIUS_MM
  const slot = LIGHTBOX_KEY_SLOT_LENGTH_MM
  const margin = 2.5
  const cx = -width * 0.2
  const cy = -height * 0.06
  const tip = cx - r - slot
  if (tip < -width / 2 + wallT + margin || cx + r > width / 2 - wallT - margin) return null
  if (cy - r < -height / 2 + wallT + margin || cy + r > height / 2 - wallT - margin) return null
  if (Math.hypot(cx, cy) < LIGHTBOX_LED_OUTER_RADIUS_MM + r + LIGHTBOX_PILLAR_CLEARANCE_MM) return null
  if (battery) {
    const shapeCx = (tip + cx + r) / 2
    const shapeHx = (cx + r - tip) / 2
    if (
      Math.abs(shapeCx - battery.cx) < shapeHx + battery.hx + 2 &&
      Math.abs(cy - battery.cy) < r + battery.hy + 2
    ) {
      return null
    }
  }
  return { cx, cy }
}

function keyholeCutters(cx, cy, wallT) {
  const pad = LIGHTBOX_THROUGH_PAD_MM
  const r = LIGHTBOX_KEY_RADIUS_MM
  const depth = wallT + pad * 2
  const circle = centeredCylinder(depth, r, 48, 'z', [cx, cy, wallT / 2])
  const xTip = cx - r - LIGHTBOX_KEY_SLOT_LENGTH_MM
  const slot = centeredCube(
    [cx - xTip, LIGHTBOX_KEY_SLOT_WIDTH_MM, depth],
    [(cx + xTip) / 2, cy, wallT / 2],
  )
  return [circle, slot]
}

function wireHole(x, y, topZ) {
  const pad = LIGHTBOX_THROUGH_PAD_MM
  const height = topZ + pad * 2
  return centeredCylinder(height, LIGHTBOX_WIRE_RADIUS_MM, 28, 'z', [x, y, topZ / 2])
}

/** Radial slot through one side of the pillar wall, full height of the tube. */
function pillarSlit(height, aimDeg) {
  const pad = LIGHTBOX_THROUGH_PAD_MM
  const x0 = LIGHTBOX_LED_INNER_RADIUS_MM * 0.25
  const x1 = LIGHTBOX_LED_OUTER_RADIUS_MM + pad
  const z0 = -pad
  const z1 = height + pad
  let box = centeredCube(
    [x1 - x0, LIGHTBOX_SLIT_WIDTH_MM, z1 - z0],
    [(x0 + x1) / 2, 0, (z0 + z1) / 2],
  )
  if (!box || Math.abs(aimDeg) < 1e-6) return box
  try {
    const turned = allocWasm(() => box.rotate([0, 0, aimDeg]))
    wasmDelete(box)
    box = null
    return turned
  } finally {
    wasmDelete(box)
  }
}

/**
 * Lightbox base frame in the engine frame: Z up, footprint centered on XY,
 * build plate at Z = 0. Tall walls are not built here.
 *
 * The returned base is one solid: floor plate (`boxWidth` × `boxHeight` ×
 * `wallThickness`), a 12 mm perimeter rim, and — for `'2xAAA'` — a flat-topped
 * battery block. Joint grooves are cut halfway through the rim thickness.
 * Screw holes pierce the rim faces. A rocker-switch window pierces the front
 * rim. A teardrop keyhole and two wire holes pierce the floor.
 *
 * The pillar is a separate hollow cylinder on the floor, with a vertical
 * slit aimed at the battery block.
 *
 * `stencilPaths` is unused until the walls are generated. Parts whose
 * `exportParts` flag is false are omitted.
 *
 * Returns `[base, pillar]`, each a watertight BufferGeometry or null, or
 * null when nothing is included.
 */
export function buildLightboxParts(settings, _stencilPaths) {
  if (!settings || settings.thingToMake !== 'lightbox') return null

  const width = lightboxMm(settings.boxWidth, 120)
  const height = lightboxMm(settings.boxHeight, 150)
  const t = lightboxMm(settings.wallThickness, 2)
  if (!(width > 1) || !(height > 1) || !(t > 0.05)) return null
  if (t * 2 >= height || t * 2 >= width) return null

  const wantBase = lightboxPartEnabled(settings, 'base')
  const wantPillar = lightboxPartEnabled(settings, 'pillar')
  if (!wantBase && !wantPillar) return null

  const rimH = LIGHTBOX_RIM_HEIGHT_MM
  const overlap = LIGHTBOX_STACK_OVERLAP_MM
  const pack = settings.batteryType === '2xAAA' ? batteryPlacement(width, height, t) : null

  let floor = null
  let front = null
  let back = null
  let left = null
  let right = null
  let battery = null
  let body = null
  let pillar = null
  let slit = null
  const knives = []
  let baseGeo = null
  let pillarGeo = null

  try {
    if (wantBase) {
      floor = centeredCube([width, height, t], [0, 0, t / 2])
      front = centeredCube([width, t, rimH], [0, -height / 2 + t / 2, rimH / 2])
      back = centeredCube([width, t, rimH], [0, height / 2 - t / 2, rimH / 2])
      left = centeredCube([t, height, rimH], [-width / 2 + t / 2, 0, rimH / 2])
      right = centeredCube([t, height, rimH], [width / 2 - t / 2, 0, rimH / 2])

      if (pack) {
        const blockH = LIGHTBOX_BATTERY_BLOCK_HEIGHT_MM + overlap
        const z0 = t - overlap
        battery = centeredCube(
          [pack.hx * 2, pack.hy * 2, blockH],
          [pack.cx, pack.cy, z0 + blockH / 2],
        )
      }

      const pieces = [floor, front, back, left, right, battery].filter(Boolean)
      floor = front = back = left = right = battery = null
      body = unionSolids(pieces)

      if (body) {
        const frontLayout = frontRimLayout(width)
        const backLayout = backRimLayout(width)
        const sideLayout = sideRimLayout(height)

        for (const x of frontLayout.notches) {
          knives.push(faceNotchX(x, LIGHTBOX_CENTER_NOTCH_WIDTH_MM, -height / 2, true, t, rimH))
        }
        if (frontLayout.switchX != null) knives.push(switchCutter(frontLayout.switchX, height, t, rimH))
        for (const x of frontLayout.screws) {
          knives.push(rimScrew('y', x, -height / 2 + t / 2, t, rimH))
        }

        for (const x of backLayout.notches) {
          knives.push(faceNotchX(x, LIGHTBOX_NOTCH_WIDTH_MM, height / 2, false, t, rimH))
        }
        for (const x of backLayout.screws) {
          knives.push(rimScrew('y', x, height / 2 - t / 2, t, rimH))
        }

        for (const y of sideLayout.notches) {
          knives.push(faceNotchY(y, LIGHTBOX_NOTCH_WIDTH_MM, -width / 2, true, t, rimH))
          knives.push(faceNotchY(y, LIGHTBOX_NOTCH_WIDTH_MM, width / 2, false, t, rimH))
        }
        for (const y of sideLayout.screws) {
          knives.push(rimScrew('x', -width / 2 + t / 2, y, t, rimH))
          knives.push(rimScrew('x', width / 2 - t / 2, y, t, rimH))
        }

        const key = keyholePlacement(width, height, t, pack)
        if (key) knives.push(...keyholeCutters(key.cx, key.cy, t))

        if (pack) {
          const topZ = t + LIGHTBOX_BATTERY_BLOCK_HEIGHT_MM
          const gap = Math.min(LIGHTBOX_WIRE_SPACING_MM, pack.hy * 2 - 8)
          if (gap > 4) {
            knives.push(wireHole(pack.cx, pack.cy - gap / 2, topZ))
            knives.push(wireHole(pack.cx, pack.cy + gap / 2, topZ))
          }
        }

        for (let i = 0; i < knives.length; i++) {
          const knife = knives[i]
          knives[i] = null
          if (knife) body = cutSolid(body, knife)
        }
      }
    }

    if (wantPillar) {
      const aim = pack ? (Math.atan2(pack.cy, pack.cx) * 180) / Math.PI : 0
      pillar = tubeSolid(
        LIGHTBOX_LED_HEIGHT_MM,
        LIGHTBOX_LED_OUTER_RADIUS_MM,
        LIGHTBOX_LED_INNER_RADIUS_MM,
        LIGHTBOX_LED_SEGMENTS,
      )
      if (pillar) {
        slit = pillarSlit(LIGHTBOX_LED_HEIGHT_MM, aim)
        pillar = cutSolid(pillar, slit)
        slit = null
      }
      if (pillar) pillar = shiftSolid(pillar, [0, 0, t - overlap])
    }

    if (body) {
      baseGeo = solidToGeo(body)
      body = null
    }
    if (pillar) {
      pillarGeo = solidToGeo(pillar)
      pillar = null
    }
    if (!baseGeo && !pillarGeo) return null
    return [baseGeo, pillarGeo]
  } catch (err) {
    baseGeo?.dispose?.()
    pillarGeo?.dispose?.()
    console.error('[manifoldEngine] buildLightboxParts failed:', err)
    return null
  } finally {
    wasmDelete(floor)
    wasmDelete(front)
    wasmDelete(back)
    wasmDelete(left)
    wasmDelete(right)
    wasmDelete(battery)
    wasmDelete(body)
    wasmDelete(pillar)
    wasmDelete(slit)
    for (const knife of knives) wasmDelete(knife)
  }
}
