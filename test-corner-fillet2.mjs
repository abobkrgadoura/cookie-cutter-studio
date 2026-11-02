import { generateFullCutterModel, fitInnerCavityPaths } from './src/lib/cutterGeometry.js'
import { defaultSettings } from './src/lib/constants.js'

function checkManifold(geometry) {
  const pos = geometry.attributes.position
  const idx = geometry.index ? geometry.index.array : null
  const key = (i) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`
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
  return { manifoldPct: 100 * (1 - bad / edgeCount.size) }
}

function hexagon(r) {
  const pts = []
  for (let i = 0; i < 6; i++) {
    const theta = (i / 6) * Math.PI * 2
    pts.push({ x: Math.cos(theta) * r, y: Math.sin(theta) * r })
  }
  return pts
}

function rectangle(w, h) {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ]
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

const settings = {
  ...defaultSettings(),
  thingToMake: 'cutter',
  width: 45,
  height: 45,
  bladeThickness: 1.0,
  handleWidth: 4,
  handleHeight: 3.5,
  handleShape: 'rectangular',
  sharpCutter: true,
}

for (const [name, raw] of [
  ['rectangle', rectangle(60, 60)],
  ['hexagon', hexagon(30)],
  ['heart', heart(2)],
]) {
  const basePaths = fitInnerCavityPaths([raw], settings)
  const model = generateFullCutterModel(basePaths, settings)
  console.log(name, 'blade:', checkManifold(model.blade).manifoldPct.toFixed(2) + '%', 'handle:', checkManifold(model.handle).manifoldPct.toFixed(2) + '%')
}
