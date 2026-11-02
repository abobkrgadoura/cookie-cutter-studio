import { mergeBufferGeometries } from 'three-stdlib'
import { generateFullCutterModel, fitInnerCavityPaths } from './src/lib/cutterGeometry.js'
import { defaultSettings } from './src/lib/constants.js'
import { computePathsBounds, offsetPolygons } from './src/lib/clipperWrapper.js'

function analyzeManifold(geometry) {
  const pos = geometry.attributes.position
  const idx = geometry.index ? geometry.index.array : null
  const key = (i) => `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`
  const edgeCount = new Map()
  const triCount = idx ? idx.length / 3 : pos.count / 3
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2
    const ka = key(a), kb = key(b), kc = key(c)
    for (const [p, q] of [[ka, kb], [kb, kc], [kc, ka]]) {
      const ek = p < q ? `${p}|${q}` : `${q}|${p}`
      edgeCount.set(ek, (edgeCount.get(ek) || 0) + 1)
    }
  }
  let bad = 0
  for (const c of edgeCount.values()) if (c !== 2) bad++
  return 100 * (1 - bad / edgeCount.size)
}

function starPath(points, outerR, innerR) {
  const pts = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR
    const theta = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
    pts.push({ x: Math.cos(theta) * r, y: Math.sin(theta) * r })
  }
  return pts
}

function heart(scale) {
  const pts = []
  const N = 60
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2
    const x = 16 * Math.pow(Math.sin(t), 3)
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    pts.push({ x: x * scale, y: y * scale })
  }
  return pts
}

function gear(teeth, outerR, innerR) {
  const pts = []
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR
    const theta = (i / (teeth * 2)) * Math.PI * 2
    pts.push({ x: Math.cos(theta) * r, y: Math.sin(theta) * r })
  }
  return pts
}

function run(name, raw, extra = {}) {
  const settings = {
    ...defaultSettings(),
    thingToMake: 'cutter',
    width: 45,
    height: 45,
    bladeThickness: 0.8,
    handleWidth: 4,
    handleHeight: 3.5,
    handleShape: 'rectangular',
    sharpCutter: true,
    ...extra,
  }
  const basePaths = fitInnerCavityPaths([raw], settings)
  const model = generateFullCutterModel(basePaths, settings)
  const parts = [model.blade, model.handle, model.bars].filter(Boolean)
  const merged = mergeBufferGeometries(parts)
  const manifoldPct = analyzeManifold(merged)

  // Confirm sizing is unaffected: the INNER cavity (eroded by
  // bladeThickness from the un-rounded basePaths) must still match target.
  const inner = offsetPolygons(basePaths, -settings.bladeThickness, { joinType: 'round' })
  const bounds = computePathsBounds(inner)
  const sizeOk = Math.abs(bounds.width - settings.width) < 0.05 && Math.abs(bounds.height - settings.height) < 0.05

  console.log(
    name.padEnd(28),
    'manifold%:', manifoldPct.toFixed(2).padStart(6),
    'innerSize:', bounds.width.toFixed(2), 'x', bounds.height.toFixed(2),
    sizeOk ? 'OK' : '*** SIZE MISMATCH ***',
  )
}

run('star5 sharp/rect', starPath(5, 40, 12))
run('star5 sharp/round', starPath(5, 40, 12), { handleShape: 'round' })
run('star5 sharp/chamfer', starPath(5, 40, 12), { handleShape: 'chamfer' })
run('star8 sharp/rect', starPath(8, 40, 10))
run('star6 very-thin/rect', starPath(6, 40, 6))
run('heart/rect', heart(2))
run('heart/round', heart(2), { handleShape: 'round' })
run('gear12/rect', gear(12, 40, 32))
run('gear12/round', gear(12, 40, 32), { handleShape: 'round' })
run('star5 thick blade/rect', starPath(5, 40, 12), { bladeThickness: 2.5, handleWidth: 6 })
run('star5 no handle', starPath(5, 40, 12), { handleHeight: 0 })
run('star5 sharp-off/rect', starPath(5, 40, 12), { sharpCutter: false })
run('star5 non-sharp cutterChamfer/rect', starPath(5, 40, 12), { cutterChamferHeight: 4, cutterChamferWidth: 0.2 })
