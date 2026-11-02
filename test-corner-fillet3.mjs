import { generateFullCutterModel, fitInnerCavityPaths } from './src/lib/cutterGeometry.js'
import { defaultSettings } from './src/lib/constants.js'

function analyzeManifold(geometry, label) {
  const pos = geometry.attributes.position
  const idx = geometry.index ? geometry.index.array : null
  const key = (i) => {
    const x = Math.round(pos.getX(i) * 1000)
    const y = Math.round(pos.getY(i) * 1000)
    const z = Math.round(pos.getZ(i) * 1000)
    return `${x},${y},${z}`
  }
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
  const dist = {}
  for (const c of edgeCount.values()) dist[c] = (dist[c] || 0) + 1
  console.log(label, 'triCount:', triCount, 'edge multiplicity distribution:', dist)
}

function rectangle(w, h) {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ]
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

const basePaths = fitInnerCavityPaths([rectangle(60, 60)], settings)
const model = generateFullCutterModel(basePaths, settings)
analyzeManifold(model.blade, 'blade')
analyzeManifold(model.handle, 'handle')
