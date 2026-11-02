import { mergeVertices } from 'three-stdlib'
import { generateFullCutterModel, fitInnerCavityPaths, buildBladeGeometry } from './src/lib/cutterGeometry.js'
import { initManifold, geometryToManifold } from './src/lib/manifoldEngine.js'
import { defaultSettings } from './src/lib/constants.js'
import {
  generateHeartPoints,
  generateStarPoints,
  generateFlowerPoints,
  generateGingerbreadPoints,
} from './src/lib/presets.js'
import { pickOuterPath } from './src/lib/textOnPath.js'

function rectangle(w, h) {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ]
}

function edgeReport(geometry) {
  const pos = geometry.attributes.position
  const idx = geometry.index ? geometry.index.array : null
  const key = (i) => `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`
  const undirected = new Map()
  const directed = new Map()
  const triCount = idx ? idx.length / 3 : pos.count / 3
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2
    const ka = key(a)
    const kb = key(b)
    const kc = key(c)
    for (const [p, q] of [
      [ka, kb],
      [kb, kc],
      [kc, ka],
    ]) {
      const ek = p < q ? `${p}|${q}` : `${q}|${p}`
      undirected.set(ek, (undirected.get(ek) || 0) + 1)
      const dk = `${p}>${q}`
      directed.set(dk, (directed.get(dk) || 0) + 1)
    }
  }
  let bad = 0
  const dist = {}
  for (const count of undirected.values()) {
    dist[count] = (dist[count] || 0) + 1
    if (count !== 2) bad++
  }
  let sameDir = 0
  for (const [ek, count] of directed) {
    if (count < 1) continue
    const [p, q] = ek.split('>')
    const rev = directed.get(`${q}>${p}`) || 0
    if (count !== 1 || rev !== 1) sameDir++
  }
  return { triCount, badEdges: bad, dist, inconsistent: sameDir }
}

function vertsInOpenZ(geometry, z0, z1) {
  const pos = geometry.attributes.position
  let n = 0
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z > z0 && z < z1) n++
  }
  return n
}

function signedVolume(geometry) {
  const pos = geometry.attributes.position
  const idx = geometry.index ? geometry.index.array : null
  const triCount = idx ? idx.length / 3 : pos.count / 3
  let v = 0
  const at = (i) => (idx ? idx[i] : i)
  for (let t = 0; t < triCount; t++) {
    const a = at(t * 3)
    const b = at(t * 3 + 1)
    const c = at(t * 3 + 2)
    const ax = pos.getX(a)
    const ay = pos.getY(a)
    const az = pos.getZ(a)
    const bx = pos.getX(b)
    const by = pos.getY(b)
    const bz = pos.getZ(b)
    const cx = pos.getX(c)
    const cy = pos.getY(c)
    const cz = pos.getZ(c)
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
  }
  return v / 6
}

function spanAt(geometry, zMin, zMax) {
  const pos = geometry.attributes.position
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let n = 0
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z < zMin || z > zMax) continue
    n++
    minX = Math.min(minX, pos.getX(i))
    maxX = Math.max(maxX, pos.getX(i))
    minY = Math.min(minY, pos.getY(i))
    maxY = Math.max(maxY, pos.getY(i))
  }
  return { n, width: maxX - minX, height: maxY - minY }
}

const settings = {
  ...defaultSettings(),
  thingToMake: 'cutter',
  width: 45,
  height: 45,
  bladeThickness: 1.0,
  bladeDepth: 12.5,
  cutterChamferWidth: 0.4,
  cutterChamferHeight: 2,
  handleWidth: 4,
  handleHeight: 3.5,
  handleShape: 'rectangular',
  sharpCutter: true,
}

await initManifold()

const shapes = [
  ['square', rectangle(60, 60)],
  ['star', generateStarPoints(5, 50, 24)],
  ['heart', generateHeartPoints(100)],
  ['flower', generateFlowerPoints(6, 50, 32, 180)],
  ['gingerbread', generateGingerbreadPoints()],
]

let failed = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`)
  }
}

for (const [name, path] of shapes) {
  console.log(`\n== ${name} ==`)
  const fitted = fitInnerCavityPaths([path], settings)
  const bladeLocal = buildBladeGeometry(fitted, settings)
  const report = edgeReport(bladeLocal)
  check('blade builds', report.triCount > 100, `tris=${report.triCount}`)

  const closed = buildBladeGeometry(fitted, { ...settings, handleHeight: 0, handleWidth: 0 })
  const welded = mergeVertices(closed.clone(), 1e-4)
  const closedReport = edgeReport(welded)
  // A valid solid can still report a couple of seam edges shared by four
  // triangles (duplicate pair). Open edges (any other valence) are a hole.
  const seamOnly = Object.keys(closedReport.dist).every((k) => k === '2' || k === '4')
  check(
    'closed blade (no handle)',
    seamOnly && closedReport.badEdges <= 4,
    JSON.stringify(closedReport.dist),
  )
  const solid = geometryToManifold(closed)
  check('manifold-3d accepts blade', !!solid && solid.status?.() === 'NoError', solid ? `status=${solid.status?.()}` : 'null')
  if (solid) {
    const vol = solid.volume()
    check('hollow volume', vol > 80 && vol < 8000, `vol=${vol.toFixed(1)}`)
    const slice = solid.slice(11.5)
    const polys = slice.toPolygons()
    check('chamfer slice is a ring', polys.length >= 2, `loops=${polys.length}`)
    slice.delete()
    solid.delete()
  }

  const mainDepth = 12.5 - 2
  const midLo = mainDepth + 0.15
  const midHi = 12.5 - 0.05
  const midVerts = vertsInOpenZ(bladeLocal, midLo, midHi)
  check('chamfer band is one ruled sheet', midVerts === 0, `midZ=${midVerts}`)

  const baseSpan = spanAt(bladeLocal, mainDepth - 0.02, mainDepth + 0.02)
  const tipSpan = spanAt(bladeLocal, 12.5 - 0.02, 12.5 + 0.02)
  check(
    'tip is narrower than chamfer base',
    tipSpan.width < baseSpan.width - 0.4 && tipSpan.height < baseSpan.height - 0.4,
    `base=${baseSpan.width.toFixed(2)}x${baseSpan.height.toFixed(2)} tip=${tipSpan.width.toFixed(2)}x${tipSpan.height.toFixed(2)}`,
  )

  const model = generateFullCutterModel(fitted, settings)
  const assembled = edgeReport(model.blade)
  check('assembled blade closed', assembled.badEdges === 0, JSON.stringify(assembled.dist))
  const assembledVol = signedVolume(model.blade)
  check('assembled blade positive volume', assembledVol > 200, `vol=${assembledVol.toFixed(1)}`)
}

console.log('\n== thick blade ==')
for (const thickness of [1.65, 1.7, 4]) {
  for (const [name, path] of [
    ['star', generateStarPoints(5, 50, 24)],
    ['heart', generateHeartPoints(100)],
  ]) {
    const fitted = fitInnerCavityPaths([path], { ...settings, bladeThickness: thickness })
    const blade = buildBladeGeometry(fitted, {
      ...settings,
      bladeThickness: thickness,
      handleHeight: 0,
      handleWidth: 0,
    })
    const pos = blade.attributes.position
    let stairs = 0
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i)
      if (z > 10.65 && z < 12.45) stairs++
    }
    const solid = geometryToManifold(blade)
    check(
      `${name} t=${thickness} ruled chamfer is manifold`,
      stairs === 0 && !!solid && solid.status?.() === 'NoError',
      `midZ=${stairs} ${solid ? solid.status?.() : 'null'}`,
    )
    solid?.delete()
  }
}

console.log('\n== sharp off ==')
const square = fitInnerCavityPaths([rectangle(60, 60)], settings)
const dull = buildBladeGeometry(square, {
  ...settings,
  sharpCutter: false,
  handleHeight: 0,
  handleWidth: 0,
})
const dullReport = edgeReport(dull)
check('dull blade closed', dullReport.badEdges === 0, JSON.stringify(dullReport.dist))
const dullSolid = geometryToManifold(dull)
check('dull blade manifold', !!dullSolid && dullSolid.status?.() === 'NoError')
dullSolid?.delete()

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
