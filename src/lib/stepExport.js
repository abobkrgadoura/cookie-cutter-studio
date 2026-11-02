import * as THREE from 'three'

// Same 0.0001 mm weld `validateWatertight` uses, so the STEP shell is the
// topology the export gate already accepted. Written coordinates are the
// welded positions, so distinct vertices cannot collapse in the file.
const WELD_SCALE = 10000
const WELD_MM = 1 / WELD_SCALE

const vertex = new THREE.Vector3()

function formatReal(n) {
  if (!Number.isFinite(n)) return '0.0'
  const rounded = Math.round(n * 1e8) / 1e8
  if (rounded === 0) return '0.0'
  const negative = rounded < 0
  const abs = Math.abs(rounded).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  const body = abs.includes('.') ? abs : `${abs}.0`
  return negative ? `-${body}` : body
}

/**
 * STEP strings are ASCII. An apostrophe is doubled. Anything else, including
 * a backslash (which starts a control directive), is written as a `\X2\`
 * UTF-16 sequence so names survive in strict readers.
 */
function stepString(value) {
  const text = String(value ?? '').slice(0, 200)
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (ch === "'") {
      out += "''"
    } else if (code >= 32 && code <= 126 && ch !== '\\') {
      out += ch
    } else {
      const units = code > 0xffff
        ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
        : [code]
      const hex = units.map((unit) => unit.toString(16).toUpperCase().padStart(4, '0')).join('')
      out += `\\X2\\${hex}\\X0\\`
    }
  }
  return `'${out}'`
}

function entityList(ids) {
  const tokens = ids.map((id) => `#${id}`)
  const inline = `(${tokens.join(',')})`
  if (inline.length <= 72) return inline
  return `(\n${tokens.join(',\n')})`
}

function stepTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '')
}

class StepWriter {
  constructor() {
    this.lines = []
    this.next = 1
    this.directions = new Map()
  }

  add(body) {
    const id = this.next++
    this.lines.push(`#${id}=${body};`)
    return id
  }

  direction(x, y, z) {
    const key = `${formatReal(x)},${formatReal(y)},${formatReal(z)}`
    const existing = this.directions.get(key)
    if (existing !== undefined) return existing
    const id = this.add(`DIRECTION('',(${key}))`)
    this.directions.set(key, id)
    return id
  }

  toFile(fileBase) {
    const name = stepString(`${fileBase}.step`)
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('Faceted boundary representation'),'2;1');",
      `FILE_NAME(${name},'${stepTimestamp()}',('Cookie Cutter Studio'),('Cookie Cutter Studio'),'Cookie Cutter Studio STEP exporter','Cookie Cutter Studio','');`,
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;',
      ...this.lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n')
  }
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s]
}

function lengthOf(a) {
  return Math.hypot(a[0], a[1], a[2])
}

function normalize(a) {
  const magnitude = lengthOf(a)
  if (magnitude < 1e-15) return null
  return scale(a, 1 / magnitude)
}

function anyPerpendicular(unit) {
  const axis = Math.abs(unit[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  return normalize(cross(unit, axis))
}

/**
 * Plane frame whose Z axis follows the triangle winding. A collapsed sliver
 * still gets a plane that contains its longest edge, so the closed shell
 * does not lose a face.
 */
function planeFrame(p0, p1, p2) {
  const e1 = sub(p1, p0)
  const e2 = sub(p2, p0)
  let normal = cross(e1, e2)
  if (lengthOf(normal) < 1e-12) {
    const spine = lengthOf(e1) >= lengthOf(e2) ? e1 : e2
    const spineUnit = normalize(spine)
    if (!spineUnit) return null
    normal = anyPerpendicular(spineUnit)
  } else {
    normal = normalize(normal)
  }
  if (!normal) return null

  let ref = normalize(e1) || normalize(e2) || anyPerpendicular(normal)
  if (!ref) return null
  ref = sub(ref, scale(normal, dot(ref, normal)))
  ref = normalize(ref) || anyPerpendicular(normal)
  if (!ref) return null
  return { normal, ref }
}

function collectFacetedMesh(mesh) {
  const position = mesh.geometry?.attributes?.position
  if (!position || position.count < 3) return null

  const index = mesh.geometry.getIndex()
  const points = []
  const ids = new Map()
  const idOf = (vertexIndex) => {
    vertex.fromBufferAttribute(position, vertexIndex)
    vertex.applyMatrix4(mesh.matrixWorld)
    const x = Math.round(vertex.x * WELD_SCALE) / WELD_SCALE
    const y = Math.round(vertex.y * WELD_SCALE) / WELD_SCALE
    const z = Math.round(vertex.z * WELD_SCALE) / WELD_SCALE
    const key = `${x},${y},${z}`
    let id = ids.get(key)
    if (id === undefined) {
      id = points.length
      points.push([x, y, z])
      ids.set(key, id)
    }
    return id
  }

  const triangles = []
  const cornerCount = index ? index.count : position.count
  for (let i = 0; i + 2 < cornerCount; i += 3) {
    const a = idOf(index ? index.getX(i) : i)
    const b = idOf(index ? index.getX(i + 1) : i + 1)
    const c = idOf(index ? index.getX(i + 2) : i + 2)
    if (a === b || b === c || c === a) continue
    triangles.push([a, b, c])
  }
  if (triangles.length === 0) return null
  return { points, triangles }
}

function writeFacetedSolid(writer, name, points, triangles) {
  const pointIds = points.map((point) => writer.add(
    `CARTESIAN_POINT('',(${formatReal(point[0])},${formatReal(point[1])},${formatReal(point[2])}))`,
  ))
  const vertexIds = pointIds.map((pointId) => writer.add(`VERTEX_POINT('',#${pointId})`))

  const edgeIds = new Map()
  const edgeOf = (a, b) => {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const key = `${lo}:${hi}`
    let id = edgeIds.get(key)
    if (id === undefined) {
      const start = points[lo]
      const end = points[hi]
      const delta = sub(end, start)
      const magnitude = lengthOf(delta)
      const direction = normalize(delta)
      if (!direction || magnitude < WELD_MM * 0.5) {
        throw new Error(`Export blocked: The ${name} has a zero-length edge that cannot be written as STEP.`)
      }
      const directionId = writer.direction(direction[0], direction[1], direction[2])
      const vectorId = writer.add(`VECTOR('',#${directionId},${formatReal(magnitude)})`)
      const lineId = writer.add(`LINE('',#${pointIds[lo]},#${vectorId})`)
      id = writer.add(`EDGE_CURVE('',#${vertexIds[lo]},#${vertexIds[hi]},#${lineId},.T.)`)
      edgeIds.set(key, id)
    }
    return { id, forward: a === lo }
  }

  const faces = []
  for (let i = 0; i < triangles.length; i++) {
    const [a, b, c] = triangles[i]
    const frame = planeFrame(points[a], points[b], points[c])
    if (!frame) {
      throw new Error(`Export blocked: The ${name} has a degenerate face that cannot be written as a STEP plane.`)
    }
    const e1 = edgeOf(a, b)
    const e2 = edgeOf(b, c)
    const e3 = edgeOf(c, a)
    const o1 = writer.add(`ORIENTED_EDGE('',*,*,#${e1.id},${e1.forward ? '.T.' : '.F.'})`)
    const o2 = writer.add(`ORIENTED_EDGE('',*,*,#${e2.id},${e2.forward ? '.T.' : '.F.'})`)
    const o3 = writer.add(`ORIENTED_EDGE('',*,*,#${e3.id},${e3.forward ? '.T.' : '.F.'})`)
    const loop = writer.add(`EDGE_LOOP('',${entityList([o1, o2, o3])})`)
    const bound = writer.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)
    const axis = writer.direction(frame.normal[0], frame.normal[1], frame.normal[2])
    const refDir = writer.direction(frame.ref[0], frame.ref[1], frame.ref[2])
    const place = writer.add(`AXIS2_PLACEMENT_3D('',#${pointIds[a]},#${axis},#${refDir})`)
    const plane = writer.add(`PLANE('',#${place})`)
    faces.push(writer.add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`))
  }

  const shell = writer.add(`CLOSED_SHELL('',${entityList(faces)})`)
  return writer.add(`MANIFOLD_SOLID_BREP(${stepString(name)},#${shell})`)
}

function writeProduct(writer, displayName) {
  const app = writer.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')")
  writer.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`)
  const productContext = writer.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`)
  const product = writer.add(`PRODUCT(${stepString(displayName)},${stepString(displayName)},'',(#${productContext}))`)
  writer.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`)
  const formation = writer.add(`PRODUCT_DEFINITION_FORMATION('1','',#${product})`)
  const definitionContext = writer.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`)
  const definition = writer.add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionContext})`)
  const shapeDef = writer.add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`)

  const lengthUnit = writer.add(`(
LENGTH_UNIT()
NAMED_UNIT(*)
SI_UNIT(.MILLI.,.METRE.)
)`)
  const planeUnit = writer.add(`(
NAMED_UNIT(*)
PLANE_ANGLE_UNIT()
SI_UNIT($,.RADIAN.)
)`)
  const solidUnit = writer.add(`(
NAMED_UNIT(*)
SI_UNIT($,.STERADIAN.)
SOLID_ANGLE_UNIT()
)`)
  const uncertainty = writer.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-4),#${lengthUnit},'distance_accuracy_value','confusion accuracy')`,
  )
  const geomContext = writer.add(`(
GEOMETRIC_REPRESENTATION_CONTEXT(3)
GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))
GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${planeUnit},#${solidUnit}))
REPRESENTATION_CONTEXT('Context','3D')
)`)
  return { shapeDef, geomContext }
}

/**
 * AP214 faceted solid. The engine's printable body is the manifold triangle
 * mesh, so each triangle becomes one planar ADVANCED_FACE. Units are
 * millimetres. `group` is the same export group STL and 3MF use; call
 * `exportModel` so the watertight gate runs first.
 */
export function buildStepFile(group, filename = 'cutter') {
  const displayName = String(filename || 'cutter').replace(/\.(stl|obj|3mf|step|stp)$/i, '') || 'cutter'
  const writer = new StepWriter()
  const { shapeDef, geomContext } = writeProduct(writer, displayName)

  const solids = []
  group.updateMatrixWorld(true)
  group.traverse((child) => {
    if (!child.isMesh) return
    const faceted = collectFacetedMesh(child)
    if (!faceted) return
    const solidName = child.name || `solid${solids.length + 1}`
    solids.push(writeFacetedSolid(writer, solidName, faceted.points, faceted.triangles))
  })

  if (solids.length === 0) {
    throw new Error('Nothing to export: the current design has no visible geometry.')
  }

  const shapeRep = writer.add(
    `ADVANCED_BREP_SHAPE_REPRESENTATION(${stepString(displayName)},${entityList(solids)},#${geomContext})`,
  )
  writer.add(`SHAPE_DEFINITION_REPRESENTATION(#${shapeDef},#${shapeRep})`)
  return writer.toFile(displayName)
}
