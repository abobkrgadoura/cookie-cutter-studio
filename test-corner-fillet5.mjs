import { mergeBufferGeometries } from 'three-stdlib'
import { generateFullCutterModel, fitInnerCavityPaths } from './src/lib/cutterGeometry.js'
import { defaultSettings } from './src/lib/constants.js'

function findBadEdges(geometry) {
  const pos = geometry.attributes.position
  const idx = geometry.index ? geometry.index.array : null
  const key = (i) => {
    const x = Math.round(pos.getX(i) * 1000)
    const y = Math.round(pos.getY(i) * 1000)
    const z = Math.round(pos.getZ(i) * 1000)
    return `${x},${y},${z}`
  }
  const edgeMap = new Map()
  const triCount = idx ? idx.length / 3 : pos.count / 3
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2
    const ka = key(a), kb = key(b), kc = key(c)
    for (const [p, q] of [[ka, kb], [kb, kc], [kc, ka]]) {
      const ek = p < q ? `${p}|${q}` : `${q}|${p}`
      if (!edgeMap.has(ek)) edgeMap.set(ek, [])
      edgeMap.get(ek).push(t)
    }
  }
  const bad = []
  for (const [ek, tris] of edgeMap) {
    if (tris.length !== 2) bad.push({ ek, count: tris.length })
  }
  return bad
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

const basePaths = fitInnerCavityPaths([starPath(5, 40, 16)], settings)
const model = generateFullCutterModel(basePaths, settings)

console.log('--- blade only ---')
console.log(findBadEdges(model.blade).slice(0, 40))
console.log('--- handle only ---')
console.log(findBadEdges(model.handle).slice(0, 40))
