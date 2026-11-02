/**
 * Editable base silhouette, end to end through the real worker steps:
 * fitInnerCavityPaths -> unionDrawingsOntoFittedCavity -> generateFullCutterModel.
 *
 * 1. A pristine silhouette round-tripped through the editor entities gives
 *    the same cavity the untouched trace gives (Rule 1).
 * 2. Erasing the silhouette shrinks the cavity in place. It is not
 *    re-normalised back up to the requested width (Rule 6).
 * 3. Moving it moves the cavity by exactly the translated millimetres.
 * 4. A filled shape is a solid region in the final manifold build.
 */
import { generateFullCutterModel, fitInnerCavityPaths } from './src/lib/cutterGeometry.js'
import { defaultSettings } from './src/lib/constants.js'
import { initManifold, getWasmLeakCount } from './src/lib/manifoldEngine.js'
import { computePathsBounds, measureFit } from './src/lib/pathMetrics.js'
import { tracePathsToBaseEntities } from './src/lib/vectorBase.js'
import { editorEntitiesToTraceStrokes } from './src/lib/vectorEntities.js'
import { eraseEntities } from './src/lib/vectorErase.js'
import { unionDrawingsOntoFittedCavity } from './src/lib/vectorStroke.js'
import { rectanglePoints } from './src/lib/vectorPrimitives.js'

await initManifold()

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function signedArea(points) {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

const totalArea = (paths) => paths.reduce((sum, loop) => sum + signedArea(loop), 0)

// A tracer-style silhouette: 160 px circle (Y up, outer positive) with a 40 px window.
function ring(cx, cy, r, n, ccw) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? 1 : -1) * 2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}
const rawPaths = [ring(300, -300, 160, 180, true), ring(300, -300, 40, 60, false)]
assert(signedArea(rawPaths[0]) > 0 && signedArea(rawPaths[1]) < 0, 'fixture winding')

const settings = {
  ...defaultSettings(),
  thingToMake: 'cutter',
  width: 64,
  height: 64,
  aspectLocked: true,
}

const fitted = fitInnerCavityPaths(rawPaths, settings)
const originalFit = measureFit(rawPaths, settings.width, settings.height, settings.aspectLocked)
const build = (replaceBase, drawings) =>
  unionDrawingsOntoFittedCavity(rawPaths, fitted, drawings, settings, replaceBase)

// ---- 1. pristine round trip -------------------------------------------------
const base = tracePathsToBaseEntities(rawPaths)
assert(base.length === 1 && base[0].holes.length === 1, 'circle + window seeds one region with one hole')

const viaTrace = build(false, [])
const viaEditor = build(true, editorEntitiesToTraceStrokes(base))
assert(viaEditor.length === viaTrace.length, `loop count ${viaEditor.length} vs ${viaTrace.length}`)
assert(Math.abs(totalArea(viaEditor) - totalArea(viaTrace)) < 1e-9, 'pristine cavity area is identical')
const vertexCount = (paths) => paths.reduce((sum, loop) => sum + loop.length, 0)
assert(vertexCount(viaEditor) === vertexCount(viaTrace), 'no vertex was added or dropped')
for (const loop of viaTrace) {
  for (const p of loop) {
    const hit = viaEditor.some((other) => other.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9))
    assert(hit, 'every traced vertex survives in place')
  }
}
const boundsTrace = computePathsBounds(viaTrace)
const boundsEditor = computePathsBounds(viaEditor)
assert(Math.abs(boundsEditor.width - boundsTrace.width) < 1e-9, 'pristine width matches')
assert(Math.abs(boundsTrace.width - settings.width) < 1e-6, 'trace cavity is the requested 64 mm')

// ---- 2. erase keeps the millimetre scale --------------------------------------
// Bite the right-hand edge of the circle. Editor frame: x=300+160, y=300.
const bitten = eraseEntities(base, { x: 460, y: 300 }, 70, 1)
assert(bitten !== base, 'eraser changed the silhouette')
const viaErase = build(true, editorEntitiesToTraceStrokes(bitten))
const boundsErase = computePathsBounds(viaErase)
assert(totalArea(viaErase) < totalArea(viaTrace) - 1, 'erasing removed material')
assert(boundsErase.width < settings.width - 3, `cavity shrank in place (width ${boundsErase.width.toFixed(2)} mm)`)
// The bite is on the editor's right edge. The X mirror puts that edge at the
// cavity minimum, so the maximum is the untouched side and must not move.
assert(Math.abs(boundsErase.maxX - boundsTrace.maxX) < 1e-6, 'the untouched edge did not move')
assert(boundsErase.minX > boundsTrace.minX + 3, 'the bitten edge moved inward')
assert(Math.abs(boundsErase.height - boundsTrace.height) < 0.5, 'height is not re-normalised')

// ---- 3. move is an exact millimetre translation -------------------------------
const dxPx = 25
const movedBase = base.map((entity) => ({
  ...entity,
  points: entity.points.map((p) => ({ x: p.x + dxPx, y: p.y })),
  holes: entity.holes.map((r) => r.map((p) => ({ x: p.x + dxPx, y: p.y }))),
}))
const viaMove = build(true, editorEntitiesToTraceStrokes(movedBase))
const boundsMove = computePathsBounds(viaMove)
const expectedShift = -dxPx * originalFit.sx // X mirror flips the direction
assert(Math.abs(boundsMove.width - boundsTrace.width) < 1e-9, 'move keeps the size')
assert(Math.abs(boundsMove.cx - boundsTrace.cx - expectedShift) < 1e-6, 'move shifts by exactly dx * mm-per-px')

// ---- 4. filled shape is solid in the manifold build ---------------------------
const stamp = {
  points: rectanglePoints({ x: 250, y: 250 }, { x: 350, y: 350 }), // covers the whole 40 px-radius window
  closed: true,
  strokeWidth: 1.5,
  lineStyle: 'filled',
}
const viaStamp = build(true, editorEntitiesToTraceStrokes([...base, stamp]))
assert(viaStamp.length === 1, `stamp closes the window (${viaStamp.length} loops)`)
assert(totalArea(viaStamp) > totalArea(viaTrace), 'stamp added material')

const settingsNoExtras = { ...settings, wallTextEnabled: false }
const bladeVerts = (cavity) => {
  const model = generateFullCutterModel(cavity, settingsNoExtras)
  const count = model?.blade?.attributes.position.count ?? 0
  for (const geo of Object.values(model || {})) geo?.dispose?.()
  return count
}
assert(
  bladeVerts(viaEditor) === bladeVerts(viaTrace),
  'pristine editor route builds the identical blade to the untouched trace',
)
for (const [label, cavity] of [
  ['trace', viaTrace],
  ['edited', viaErase],
  ['moved', viaMove],
  ['stamped', viaStamp],
]) {
  const model = generateFullCutterModel(cavity, settingsNoExtras)
  assert(model?.blade, `${label}: manifold build returned a blade`)
  const verts = model.blade.attributes.position.count
  assert(verts > 100, `${label}: blade has geometry (${verts} verts)`)
  console.log(`  ${label}: ${verts} blade vertices`)
  for (const geo of Object.values(model)) geo?.dispose?.()
}

assert(getWasmLeakCount() === 0, `WASM objects leaked: ${getWasmLeakCount()}`)
console.log('base edit pipeline checks passed')
