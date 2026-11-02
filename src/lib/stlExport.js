import * as THREE from 'three'
import { OBJExporter, STLExporter } from 'three-stdlib'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { computeStampZ } from './pathMetrics.js'
import { LIGHTBOX_MESH_KEYS } from './presets.js'
import { buildStepFile } from './stepExport.js'

// 0.0001 mm, the same weld `finalizeGeometry` uses before creasing.
// Creased normals are non-indexed, so shared corners match by position.
const WELD_SCALE = 10000
// Packs an edge (min, max) while both vertex ids stay under 1e7.
const EDGE_STRIDE = 10000000

const PART_ADVICE = {
  stamp: 'Pattern lines might be too thin or self-intersecting. Try increasing Pattern Thickness.',
  blade: 'Cutter walls overlap incorrectly. Try reducing the Chamfer or adjusting Wall Thickness.',
  handle: 'The handle shape is self-intersecting. Try reducing Handle Width.',
  bridges: 'Center bars overlap the wall or each other. Try reducing bar width.',
  stencil: 'The stencil outline is open or self-intersecting. Try a cleaner silhouette.',
  base: 'The lightbox base pocket cut failed. Try a larger box or a thicker base.',
  pillar: 'The LED pillar is not a closed tube. Try regenerating the lightbox.',
  'front wall': 'The stencil cut opened the front wall. Try a simpler silhouette.',
  'back wall': 'The back wall is not a closed plate. Try regenerating the lightbox.',
  'left wall': 'The left wall is not a closed plate. Try regenerating the lightbox.',
  'right wall': 'The right wall is not a closed plate. Try regenerating the lightbox.',
}

/**
 * A closed 2-manifold shell has exactly two triangles on every edge.
 * One triangle means a hole. More than two means a non-manifold join.
 * Negative signed volume means the shell is inside-out.
 */
function validateWatertight(geo, partName) {
  const position = geo?.attributes?.position
  if (!position || position.count < 3) return

  const index = geo.index ? geo.index.array : null
  const cornerCount = index ? index.length : position.count
  if (cornerCount < 3) return

  const vertexIds = new Map()
  const idOf = (vertexIndex) => {
    const x = Math.round(position.getX(vertexIndex) * WELD_SCALE)
    const y = Math.round(position.getY(vertexIndex) * WELD_SCALE)
    const z = Math.round(position.getZ(vertexIndex) * WELD_SCALE)
    const key = `${x},${y},${z}`
    let id = vertexIds.get(key)
    if (id === undefined) {
      id = vertexIds.size
      vertexIds.set(key, id)
    }
    return id
  }

  const edges = new Map()
  const addEdge = (a, b) => {
    if (a === b) return
    const min = a < b ? a : b
    const max = a > b ? a : b
    const key = max < EDGE_STRIDE ? max * EDGE_STRIDE + min : `${min},${max}`
    edges.set(key, (edges.get(key) || 0) + 1)
  }

  let solidTriangles = 0
  for (let i = 0; i + 2 < cornerCount; i += 3) {
    const a = idOf(index ? index[i] : i)
    const b = idOf(index ? index[i + 1] : i + 1)
    const c = idOf(index ? index[i + 2] : i + 2)
    if (a === b || b === c || c === a) continue
    addEdge(a, b)
    addEdge(b, c)
    addEdge(c, a)
    solidTriangles += 1
  }

  let signedVolume = 0
  for (let i = 0; i + 2 < cornerCount; i += 3) {
    const a = idOf(index ? index[i] : i)
    const b = idOf(index ? index[i + 1] : i + 1)
    const c = idOf(index ? index[i + 2] : i + 2)
    if (a === b || b === c || c === a) continue

    // Only calculate volume using actual positions, not the welded IDs, for mathematical accuracy
    const iA = index ? index[i] : i
    const iB = index ? index[i + 1] : i + 1
    const iC = index ? index[i + 2] : i + 2
    const p1x = position.getX(iA), p1y = position.getY(iA), p1z = position.getZ(iA)
    const p2x = position.getX(iB), p2y = position.getY(iB), p2z = position.getZ(iB)
    const p3x = position.getX(iC), p3y = position.getY(iC), p3z = position.getZ(iC)

    signedVolume += p1x * p2y * p3z - p1x * p3y * p2z - p2x * p1y * p3z + p2x * p3y * p1z + p3x * p1y * p2z - p3x * p2y * p1z
  }

  if (signedVolume < 0) {
    throw new Error(`Export blocked: The ${partName} has inverted normals (inside-out). Please adjust settings and regenerate.`)
  }

  if (solidTriangles === 0) {
    throw new Error(
      `Export blocked: The ${partName} has no solid triangles. Please adjust settings and regenerate.`,
    )
  }

  let open = 0
  let complex = 0
  for (const count of edges.values()) {
    if (count === 1) open += 1
    else if (count > 2) complex += 1
  }

  if (open > 0 || complex > 0) {
    const advice = PART_ADVICE[partName] || 'Please adjust settings and regenerate.'
    throw new Error(
      `Export blocked: The ${partName} has ${open} open edges and ${complex} non-manifold edges. ${advice}`,
    )
  }
}

/**
 * Assembles the generated solids into a `THREE.Group` independent of the
 * React-Fiber scene. Handle, bars, and wall text are already boolean-unioned
 * into `model.blade`, so they are not exported again. The stamp stays a
 * separate body, with the same Z as the preview.
 */
export function buildExportGroup(model, settings) {
  const group = new THREE.Group()

  const addPart = (geo, name, position) => {
    const positions = geo?.attributes?.position
    if (!positions || positions.count < 3) return
    const mesh = new THREE.Mesh(geo)
    mesh.name = name
    if (position) mesh.position.set(position[0], position[1], position[2])
    group.add(mesh)
  }

  if (model) {
    addPart(model.stencil, 'stencil')
    addPart(model.blade, 'blade')
    if (model.stamp) addPart(model.stamp, 'stamp', [0, 0, computeStampZ(settings)])
    for (const key of LIGHTBOX_MESH_KEYS) {
      const name = LIGHTBOX_EXPORT_NAMES[key]
      if (name) addPart(model[key], name)
    }
  }

  if (group.children.length === 0) {
    throw new Error('Export failed: Geometry is empty or invalid.')
  }

  group.updateMatrixWorld(true)
  return group
}

const LIGHTBOX_EXPORT_NAMES = {
  base: 'base',
  pillar: 'pillar',
  wallFront: 'front wall',
  wallBack: 'back wall',
  wallLeft: 'left wall',
  wallRight: 'right wall',
}

const EXPORT_FORMATS = {
  stl: { ext: 'stl', type: 'model/stl' },
  obj: { ext: 'obj', type: 'model/obj' },
  '3mf': { ext: '3mf', type: 'model/3mf' },
  step: { ext: 'step', type: 'application/step' },
}

function assertExportable(model) {
  if (!model) {
    throw new Error('No geometry to export yet — wait for the model to finish generating.')
  }
}

function withExtension(filename, ext) {
  const base = String(filename || 'cutter').replace(/\.(stl|obj|3mf|step|stp)$/i, '')
  return `${base}.${ext}`
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function requireGroup(model, settings) {
  if (model.blade) validateWatertight(model.blade, 'blade')
  if (model.stamp) validateWatertight(model.stamp, 'stamp')
  if (model.handle) validateWatertight(model.handle, 'handle')
  if (model.bars) validateWatertight(model.bars, 'bridges')
  if (model.stencil) validateWatertight(model.stencil, 'stencil')
  for (const key of LIGHTBOX_MESH_KEYS) {
    const name = LIGHTBOX_EXPORT_NAMES[key]
    if (name && model[key]) validateWatertight(model[key], name)
  }

  const group = buildExportGroup(model, settings)
  if (group.children.length === 0) {
    throw new Error('Nothing to export: the current design has no visible geometry.')
  }
  return group
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(5) : '0'
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

/**
 * Core 3MF package. three.js 0.185 ships `3MFLoader` and no `3MFExporter`,
 * so the archive is written to the same core spec that loader reads:
 * `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`.
 */
export function build3MFArchive(group) {
  const objects = []
  const buildItems = []
  let nextId = 1
  const vertex = new THREE.Vector3()

  group.traverse((child) => {
    if (!child.isMesh) return
    const position = child.geometry?.getAttribute('position')
    if (!position || position.count < 3) return

    const index = child.geometry.getIndex()
    const vertices = []
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i)
      vertex.applyMatrix4(child.matrixWorld)
      vertices.push(`<vertex x="${fmt(vertex.x)}" y="${fmt(vertex.y)}" z="${fmt(vertex.z)}"/>`)
    }

    const triangles = []
    const triCount = index ? index.count : position.count
    for (let i = 0; i + 2 < triCount; i += 3) {
      const a = index ? index.getX(i) : i
      const b = index ? index.getX(i + 1) : i + 1
      const c = index ? index.getX(i + 2) : i + 2
      triangles.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    }
    if (triangles.length === 0) return

    const id = nextId++
    const name = xmlEscape(child.name || `part${id}`)
    objects.push(
      `<object id="${id}" type="model" name="${name}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`,
    )
    buildItems.push(`<item objectid="${id}"/>`)
  })

  if (objects.length === 0) {
    throw new Error('Nothing to export: the current design has no visible geometry.')
  }

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>${objects.join('')}</resources>
  <build>${buildItems.join('')}</build>
</model>`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`

  const encode = (text) => new TextEncoder().encode(text)
  return zipSync({
    '[Content_Types].xml': encode(contentTypes),
    '_rels/.rels': encode(rels),
    '3D/3dmodel.model': encode(modelXml),
  })
}

/**
 * Download the current cutter. `format` is `stl`, `obj`, `3mf`, or `step`.
 * All four use `buildExportGroup` after the same watertight check.
 */
export function exportModel(model, settings, filename = 'cutter', format = 'stl') {
  assertExportable(model)
  const spec = EXPORT_FORMATS[format]
  if (!spec) throw new Error(`Unsupported export format: ${format}`)

  const group = requireGroup(model, settings)
  let blob
  if (format === 'stl') {
    const result = new STLExporter().parse(group, { binary: true })
    blob = new Blob([result], { type: spec.type })
  } else if (format === 'obj') {
    const result = new OBJExporter().parse(group)
    blob = new Blob([result], { type: spec.type })
  } else if (format === 'step') {
    blob = new Blob([buildStepFile(group, filename)], { type: spec.type })
  } else {
    blob = new Blob([build3MFArchive(group)], { type: spec.type })
  }

  triggerDownload(blob, withExtension(filename, spec.ext))
}

/** Binary STL download. Kept for callers that only need STL. */
export function exportModelToSTL(model, settings, filename = 'cutter.stl') {
  exportModel(model, settings, filename, 'stl')
}
