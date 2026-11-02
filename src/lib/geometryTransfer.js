import * as THREE from 'three'

/**
 * A `THREE.BufferGeometry` can't cross a postMessage boundary as-is (it's a
 * class instance with methods, getters, etc. — structured clone would drop
 * all of that). What CAN cross cheaply — with zero copying, using the
 * Transferable protocol — are the raw typed arrays backing its attributes.
 *
 * `serializeGeometry` extracts exactly those arrays plus the handful of
 * scalar fields (bounding sphere) needed to reconstruct a fully-usable
 * geometry on the other side, and `deserializeGeometry` rebuilds it.
 * The typed arrays are the geometry's own buffers, not copies.
 * `collectTransferables` gathers every ArrayBuffer involved so the caller
 * can pass them as the `postMessage` transfer list. After that transfer
 * succeeds, `releaseTransferredGeometry` must drop the source geometry's
 * attribute references before dispose — those ArrayBuffers are detached.
 */
export function serializeGeometry(geo) {
  if (!geo) return null
  geo.computeBoundingSphere()
  geo.computeBoundingBox()

  const position = geo.attributes.position ? geo.attributes.position.array : null
  const normal = geo.attributes.normal ? geo.attributes.normal.array : null
  const uv = geo.attributes.uv ? geo.attributes.uv.array : null
  const index = geo.index ? geo.index.array : null

  return {
    position,
    normal,
    uv,
    index,
    indexIsUint32: index instanceof Uint32Array,
  }
}

export function deserializeGeometry(data) {
  if (!data || !data.position) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3))
  if (data.normal) {
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3))
  }
  if (data.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2))
  }
  if (data.index) {
    geo.setIndex(new THREE.BufferAttribute(data.index, 1))
  }
  if (!data.normal) {
    geo.computeVertexNormals()
  } else {
    geo.attributes.normal.needsUpdate = true
  }
  return geo
}

/** Serializes every named geometry in a `{ blade, handle, ... }` model map. */
export function serializeModel(model) {
  if (!model) return null
  const out = {}
  for (const key of Object.keys(model)) {
    out[key] = serializeGeometry(model[key])
  }
  return out
}

export function deserializeModel(data) {
  if (!data) return null
  const out = {}
  for (const key of Object.keys(data)) {
    out[key] = deserializeGeometry(data[key])
  }
  return out
}

/** Walks a serialized model (or a single serialized geometry) and collects
 * every backing ArrayBuffer for use as a `postMessage` transfer list. */
export function collectTransferables(serialized) {
  const buffers = []
  const visitGeo = (g) => {
    if (!g) return
    if (g.position) buffers.push(g.position.buffer)
    if (g.normal) buffers.push(g.normal.buffer)
    if (g.uv) buffers.push(g.uv.buffer)
    if (g.index) buffers.push(g.index.buffer)
  }
  if (!serialized) return buffers
  if (serialized.position !== undefined) {
    visitGeo(serialized)
  } else {
    for (const key of Object.keys(serialized)) visitGeo(serialized[key])
  }
  const unique = []
  const seen = new Set()
  for (const buf of buffers) {
    if (buf && !seen.has(buf)) {
      seen.add(buf)
      unique.push(buf)
    }
  }
  return unique
}

/**
 * Packs a `{x,y}[][]` path list into two typed arrays so GENERATE_MODEL
 * can transfer them as ArrayBuffers instead of structured-cloning
 * thousands of plain objects on every slider-debounce.
 */
export function packPaths(paths, roles) {
  if (!paths || paths.length === 0) return null
  const counts = new Uint32Array(paths.length)
  let n = 0
  for (let i = 0; i < paths.length; i++) {
    counts[i] = paths[i].length
    n += paths[i].length
  }
  const xy = new Float32Array(n * 2)
  let o = 0
  for (const loop of paths) {
    for (const p of loop) {
      xy[o++] = p.x
      xy[o++] = p.y
    }
  }
  const packed = { counts, xy }
  if (roles && roles.length === paths.length) {
    packed.roles = Uint8Array.from(roles, (role) => {
      const nRole = Number(role)
      return nRole === 1 || nRole === 2 ? nRole : 0
    })
  }
  return packed
}

export function unpackPaths(packed) {
  if (!packed || !packed.counts || !packed.xy) return []
  const { counts, xy } = packed
  const paths = []
  let o = 0
  for (let i = 0; i < counts.length; i++) {
    const loop = []
    const n = counts[i]
    for (let k = 0; k < n; k++) {
      loop.push({ x: xy[o], y: xy[o + 1] })
      o += 2
    }
    paths.push(loop)
  }
  return paths
}

export function unpackRoles(packed) {
  if (!packed?.roles || packed.roles.length === 0) return null
  return Array.from(packed.roles)
}

export function collectPathTransferables(packed) {
  if (!packed) return []
  const buffers = []
  if (packed.counts) buffers.push(packed.counts.buffer)
  if (packed.xy) buffers.push(packed.xy.buffer)
  if (packed.roles) buffers.push(packed.roles.buffer)
  return buffers
}

/**
 * Severs a geometry from attribute buffers that `postMessage` has already
 * transferred. The typed arrays are detached on this thread: reading
 * `.length` / `.byteLength`, zeroing them, or calling `.delete()` throws.
 * This only drops the property references.
 */
export function releaseTransferredGeometry(geo) {
  if (!geo) return
  const attrs = geo.attributes
  if (attrs) {
    for (const key of Object.keys(attrs)) delete attrs[key]
  }
  geo.index = null
  const morph = geo.morphAttributes
  if (morph) {
    for (const key of Object.keys(morph)) delete morph[key]
  }
}
