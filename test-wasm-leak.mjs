import * as THREE from 'three'
import { generateFullCutterModel } from './src/lib/cutterGeometry.js'
import { defaultSettings } from './src/lib/constants.js'
import {
  beginWasmScope,
  extrudeAndUnion,
  extrudeOffsetProfile,
  extrudePaths,
  extrudeRing,
  geometryToManifold,
  getWasmLeakCount,
  initManifold,
  manifoldToGeometry,
  offsetPathsManifold,
  sweepWasmScope,
  unionBufferGeometries,
} from './src/lib/manifoldEngine.js'

await initManifold()

const square = [[
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]]

const hole = [[
  { x: 2, y: 2 },
  { x: 2, y: 8 },
  { x: 8, y: 8 },
  { x: 8, y: 2 },
]]

let failed = 0

function check(label, expected = 0) {
  const live = getWasmLeakCount()
  if (live !== expected) {
    failed += 1
    console.error(`[wasm-leak] ${label} live=${live} expected=${expected}`)
  } else {
    console.log(`[wasm-leak] ${label} live=${live}`)
  }
}

if (getWasmLeakCount() !== 0) {
  console.error('[wasm-leak] init left WASM objects alive', getWasmLeakCount())
  process.exit(1)
}

{
  const geo = extrudePaths(square, 4, { z0: 1 })
  if (!geo) throw new Error('extrudePaths returned null')
  check('extrudePaths releases its solid')
  const solid = geometryToManifold(geo)
  if (!solid) throw new Error('geometryToManifold returned null')
  check('round-trip holds the returned solid', 1)
  const copy = manifoldToGeometry(solid)
  if (!copy) throw new Error('manifoldToGeometry returned null')
  check('getMesh copy does not add a handle', 1)
  solid.delete()
  copy.dispose()
  geo.dispose()
  check('extrude + round-trip')
}

{
  const bad = new THREE.BufferGeometry()
  bad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
  bad.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1))
  const solid = geometryToManifold(bad)
  if (solid) {
    solid.delete()
    throw new Error('non-manifold triangle must not return a solid')
  }
  bad.dispose()
  check('rejected mesh deletes its solid')
}

{
  const outer = offsetPathsManifold(square, 1.2, { joinType: 'Round', circularSegments: 8 })
  const ring = extrudeRing(outer, square, 3, { z0: 0.5, openBottom: true })
  ring?.dispose()
  const unioned = extrudeAndUnion([
    { paths: square, height: 1, z0: 0 },
    { paths: hole, height: 0.4, z0: 0.8 },
  ])
  unioned?.dispose()
  check('offset, ring, union')
}

{
  const getOuter = (delta) => offsetPathsManifold(square, delta, { circularSegments: 8 })
  const block = extrudeOffsetProfile(square, [
    { z: 0, offset: 1.5 },
    { z: 6, offset: 1.5 },
  ], getOuter)
  const taper = extrudeOffsetProfile(square, [
    { z: 0, offset: 2 },
    { z: 3, offset: 0.6 },
  ], getOuter)
  if (!block || !taper) throw new Error('extrudeOffsetProfile returned null')
  const fused = unionBufferGeometries(block, taper)
  fused?.dispose()
  block.dispose()
  taper.dispose()
  check('offset profile + buffer union')
}

{
  const settings = defaultSettings()
  const cavity = [[
    { x: -20, y: -15 },
    { x: 20, y: -15 },
    { x: 20, y: 15 },
    { x: -20, y: 15 },
  ]]
  for (let i = 0; i < 2; i++) {
    const model = generateFullCutterModel(cavity, settings)
    if (!model?.blade) throw new Error('generateFullCutterModel returned no blade')
    model.blade?.dispose()
    model.handle?.dispose()
    model.bars?.dispose()
    model.stamp?.dispose()
    model.wallText?.dispose()
    model.stencil?.dispose()
    check(`generateFullCutterModel cycle ${i + 1}`)
  }
}

{
  const good = extrudePaths(square, 2)
  const bad = new THREE.BufferGeometry()
  bad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
  bad.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1))
  const fused = unionBufferGeometries(good, bad)
  if (fused) {
    fused.dispose()
    failed += 1
    console.error('[wasm-leak] non-manifold union must not return a solid')
  }
  good?.dispose()
  bad.dispose()
  check('failed buffer union releases both operands')
}

{
  const heldScope = beginWasmScope()
  const geo = extrudePaths(square, 2)
  const solid = geometryToManifold(geo)
  if (!solid) throw new Error('scope fixture returned no solid')
  const other = beginWasmScope()
  const untouched = sweepWasmScope(other)
  if (untouched !== 0) {
    failed += 1
    console.error(`[wasm-leak] empty scope released ${untouched} handle(s)`)
  }
  check('sweep of another scope leaves the held solid', 1)
  const released = sweepWasmScope(heldScope)
  if (released !== 1) {
    failed += 1
    console.error(`[wasm-leak] scope sweep released ${released}, expected 1`)
  }
  geo.dispose()
  check('scope sweep deletes the abandoned solid')
}

if (failed > 0) {
  console.error(`[wasm-leak] ${failed} cycle(s) leaked`)
  process.exit(1)
}
console.log('[wasm-leak] ok', getWasmLeakCount())
