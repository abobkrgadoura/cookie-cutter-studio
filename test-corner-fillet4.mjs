import * as THREE from 'three'
import { mergeBufferGeometries } from 'three-stdlib'
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
  const bad = Object.entries(dist).filter(([k]) => k !== '2').reduce((s, [, v]) => s + v, 0)
  console.log(label, 'triCount:', triCount, 'edgeDist:', dist, 'manifold%:', (100 * (1 - bad / edgeCount.size)).toFixed(2))
}

function rectangle(w, h) {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ]
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

function testShape(name, raw, extraSettings = {}) {
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
    ...extraSettings,
  }
  const basePaths = fitInnerCavityPaths([raw], settings)
  const model = generateFullCutterModel(basePaths, settings)
  const parts = [model.blade, model.handle, model.bars].filter(Boolean)
  const merged = mergeBufferGeometries(parts)
  analyzeManifold(merged, name)
}

testShape('rectangle/rect-handle', rectangle(60, 60))
testShape('rectangle/round-handle', rectangle(60, 60), { handleShape: 'round' })
testShape('rectangle/chamfer-handle', rectangle(60, 60), { handleShape: 'chamfer' })
testShape('star5/rect-handle', starPath(5, 40, 16))
testShape('star5/round-handle', starPath(5, 40, 16), { handleShape: 'round' })
testShape('star5/no-sharp', starPath(5, 40, 16), { sharpCutter: false })
