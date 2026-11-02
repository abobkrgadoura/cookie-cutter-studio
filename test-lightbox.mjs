import { buildLightboxGeometry } from './src/lib/cutterGeometry.js'
import { defaultSettings } from './src/lib/constants.js'
import { beginWasmScope, getWasmLeakCount, initManifold, sweepWasmScope } from './src/lib/manifoldEngine.js'
import { buildExportGroup } from './src/lib/stlExport.js'

await initManifold()

let failed = 0

function assert(label, cond, detail) {
  if (cond) {
    console.log(`ok  ${label}`)
    return
  }
  failed += 1
  console.error(`FAIL ${label}${detail != null ? ` — ${detail}` : ''}`)
}

function near(a, b, eps = 0.05) {
  return Math.abs(a - b) <= eps
}

function boundsOf(geo) {
  geo.computeBoundingBox()
  const box = geo.boundingBox
  return {
    minX: box.min.x,
    minY: box.min.y,
    minZ: box.min.z,
    maxX: box.max.x,
    maxY: box.max.y,
    maxZ: box.max.z,
  }
}

function signedVolume(geo) {
  const pos = geo.attributes.position
  const idx = geo.index ? geo.index.array : null
  const n = idx ? idx.length : pos.count
  let v = 0
  for (let i = 0; i + 2 < n; i += 3) {
    const i0 = idx ? idx[i] : i
    const i1 = idx ? idx[i + 1] : i + 1
    const i2 = idx ? idx[i + 2] : i + 2
    const ax = pos.getX(i0)
    const ay = pos.getY(i0)
    const az = pos.getZ(i0)
    const bx = pos.getX(i1)
    const by = pos.getY(i1)
    const bz = pos.getZ(i1)
    const cx = pos.getX(i2)
    const cy = pos.getY(i2)
    const cz = pos.getZ(i2)
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return v / 6
}

function edgeCounts(geo) {
  const pos = geo.attributes.position
  const idx = geo.index ? geo.index.array : null
  const n = idx ? idx.length : pos.count
  const weld = 10000
  const idOf = (i) =>
    `${Math.round(pos.getX(i) * weld)},${Math.round(pos.getY(i) * weld)},${Math.round(pos.getZ(i) * weld)}`
  const edges = new Map()
  const add = (a, b) => {
    if (a === b) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    edges.set(key, (edges.get(key) || 0) + 1)
  }
  for (let i = 0; i + 2 < n; i += 3) {
    const a = idOf(idx ? idx[i] : i)
    const b = idOf(idx ? idx[i + 1] : i + 1)
    const c = idOf(idx ? idx[i + 2] : i + 2)
    if (a === b || b === c || c === a) continue
    add(a, b)
    add(b, c)
    add(c, a)
  }
  let open = 0
  let complex = 0
  for (const count of edges.values()) {
    if (count === 1) open += 1
    else if (count > 2) complex += 1
  }
  return { open, complex }
}

function firstHit(geo, origin, dir) {
  const pos = geo.attributes.position
  const idx = geo.index ? geo.index.array : null
  const n = idx ? idx.length : pos.count
  const eps = 1e-7
  let best = Infinity
  let hit = null
  for (let i = 0; i + 2 < n; i += 3) {
    const i0 = idx ? idx[i] : i
    const i1 = idx ? idx[i + 1] : i + 1
    const i2 = idx ? idx[i + 2] : i + 2
    const ax = pos.getX(i0)
    const ay = pos.getY(i0)
    const az = pos.getZ(i0)
    const e1x = pos.getX(i1) - ax
    const e1y = pos.getY(i1) - ay
    const e1z = pos.getZ(i1) - az
    const e2x = pos.getX(i2) - ax
    const e2y = pos.getY(i2) - ay
    const e2z = pos.getZ(i2) - az
    const px = dir[1] * e2z - dir[2] * e2y
    const py = dir[2] * e2x - dir[0] * e2z
    const pz = dir[0] * e2y - dir[1] * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < eps) continue
    const inv = 1 / det
    const tx = origin[0] - ax
    const ty = origin[1] - ay
    const tz = origin[2] - az
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < -eps || u > 1 + eps) continue
    const qx = ty * e1z - tz * e1y
    const qy = tz * e1x - tx * e1z
    const qz = tx * e1y - ty * e1x
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv
    if (v < -eps || u + v > 1 + eps) continue
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (t > eps && t < best) {
      best = t
      hit = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t]
    }
  }
  return hit
}

function disposeModel(model) {
  if (!model) return
  for (const geo of Object.values(model)) geo?.dispose?.()
}

function lightboxSettings(patch) {
  return { ...defaultSettings(), thingToMake: 'lightbox', ...patch }
}

function build(settings, paths) {
  const scope = beginWasmScope()
  const before = getWasmLeakCount()
  const model = buildLightboxGeometry(settings, paths)
  const leaked = getWasmLeakCount() - before
  const swept = sweepWasmScope(scope)
  return { model, leaked, swept }
}

const plain = build(lightboxSettings())
assert('no wasm leak on the plain box', plain.leaked === 0 && plain.swept === 0, `leaked=${plain.leaked} swept=${plain.swept}`)
assert(
  'base frame is only the tray and the pillar',
  plain.model && plain.model.base && plain.model.pillar && !plain.model.wallFront && !plain.model.wallBack && !plain.model.wallLeft && !plain.model.wallRight,
)

if (plain.model) {
  for (const [key, geo] of Object.entries(plain.model)) {
    const edges = edgeCounts(geo)
    const volume = signedVolume(geo)
    assert(`${key} is watertight`, edges.open === 0 && edges.complex === 0, JSON.stringify(edges))
    assert(`${key} volume is positive`, volume > 1, volume.toFixed(2))
  }

  const base = boundsOf(plain.model.base)
  assert('base footprint', near(base.minX, -60) && near(base.maxX, 60) && near(base.minY, -75) && near(base.maxY, 75))
  assert('rim is 12 mm, not the box depth', near(base.minZ, 0) && near(base.maxZ, 12), `maxZ=${base.maxZ}`)

  const floorHit = firstHit(plain.model.base, [0, -30, 30], [0, 0, -1])
  assert('open floor is the plate thickness', floorHit && near(floorHit[2], 2), floorHit && floorHit[2].toFixed(3))

  const groove = firstHit(plain.model.base, [0, -120, 6], [0, 1, 0])
  assert('front center groove stops halfway through the rim', groove && groove[1] > -74.4 && groove[1] < -73.4, groove && groove[1].toFixed(3))

  const solidFront = firstHit(plain.model.base, [-55, -120, 6], [0, 1, 0])
  assert('front skin outside the groove is intact', solidFront && near(solidFront[1], -75), solidFront && solidFront[1].toFixed(3))

  const switchHit = firstHit(plain.model.base, [120 * 0.18, -120, 6], [0, 1, 0])
  assert('rocker window opens the front rim', switchHit && switchHit[1] > 20, switchHit && switchHit[1].toFixed(3))

  const screwHit = firstHit(plain.model.base, [-120 * 0.32, -120, 6], [0, 1, 0])
  assert('front screw hole opens the rim', screwHit && screwHit[1] > 20, screwHit && screwHit[1].toFixed(3))

  const keyHit = firstHit(plain.model.base, [-120 * 0.2, -150 * 0.06, -5], [0, 0, 1])
  assert('keyhole pierces the floor', keyHit == null)

  const batteryTop = firstHit(plain.model.base, [43, 44, 30], [0, 0, -1])
  const batterySide = firstHit(plain.model.base, [38, 50, 30], [0, 0, -1])
  assert('battery block top is flat', batteryTop && batterySide && near(batteryTop[2], 10) && near(batterySide[2], batteryTop[2]), `${batteryTop?.[2]} ${batterySide?.[2]}`)

  const wireHit = firstHit(plain.model.base, [43, 52, -5], [0, 0, 1])
  assert('wire hole pierces the battery block and the floor', wireHit == null)

  const pillar = boundsOf(plain.model.pillar)
  assert('pillar stands on the floor', near(pillar.minZ, 2, 0.05) && near(pillar.maxZ, 14, 0.05))
  assert('pillar is centered', near(pillar.minX, -4) && near(pillar.maxX, 4) && near(pillar.minY, -4) && near(pillar.maxY, 4))

  const aim = Math.atan2(44, 43)
  const ux = Math.cos(aim)
  const uy = Math.sin(aim)
  const slitHit = firstHit(plain.model.pillar, [ux * 20, uy * 20, 8], [-ux, -uy, 0])
  const slitDot = slitHit ? slitHit[0] * ux + slitHit[1] * uy : 99
  assert('pillar slit opens the near wall', slitDot < 0, slitHit && slitDot.toFixed(3))

  const tubeVol = Math.PI * (16 - 2.6 * 2.6) * 12
  const pillarVol = signedVolume(plain.model.pillar)
  assert('slit removes pillar wall', pillarVol < tubeVol - 4 && pillarVol > tubeVol * 0.7, `got ${pillarVol.toFixed(1)} tube ${tubeVol.toFixed(1)}`)

  const group = buildExportGroup(plain.model, lightboxSettings())
  assert('export group keeps the tray and the pillar', group.children.length === 2, String(group.children.length))
}

const noBattery = build(lightboxSettings({ batteryType: 'None' }))
assert('no leak without the block', noBattery.leaked === 0 && noBattery.swept === 0)
if (plain.model && noBattery.model) {
  const withBlock = signedVolume(plain.model.base)
  const without = signedVolume(noBattery.model.base)
  assert('None omits the battery block', withBlock > without + 5000, `aaa ${withBlock.toFixed(1)} none ${without.toFixed(1)}`)
  const edges = edgeCounts(noBattery.model.base)
  assert('base without the block stays watertight', edges.open === 0 && edges.complex === 0, JSON.stringify(edges))
}

const tiny = build(lightboxSettings({ boxWidth: 40, boxHeight: 40, boxDepth: 20, wallThickness: 2 }))
assert('tiny box does not leak', tiny.leaked === 0 && tiny.swept === 0)
if (tiny.model) {
  const box = boundsOf(tiny.model.base)
  const edges = edgeCounts(tiny.model.base)
  assert('tiny tray stays 12 mm tall', near(box.maxZ, 12) && near(box.minX, -20) && near(box.maxX, 20))
  assert('tiny tray is watertight', edges.open === 0 && edges.complex === 0, JSON.stringify(edges))
  const top = firstHit(tiny.model.base, [0, 0, 30], [0, 0, -1])
  assert('tiny box skips the 53 mm block', top && near(top[2], 2), top && top[2].toFixed(3))
}

const filtered = build(
  lightboxSettings({
    exportParts: { walls: true, base: false, pillar: false, imagePlate: true },
  }),
)
assert('export flags drop base and pillar', filtered.model == null)
assert('filtered build does not leak', filtered.leaked === 0 && filtered.swept === 0)

const wideShort = [[
  { x: -50, y: -5 },
  { x: 50, y: -5 },
  { x: 50, y: 5 },
  { x: -50, y: 5 },
]]
const cut = build(lightboxSettings(), wideShort)
assert('stencil paths do not leak', cut.leaked === 0 && cut.swept === 0)
if (cut.model && plain.model) {
  assert('stencil paths do not add walls', !cut.model.wallFront)
  const solid = signedVolume(plain.model.base)
  const same = signedVolume(cut.model.base)
  assert('stencil paths do not change the base frame', Math.abs(solid - same) < 1, `plain ${solid.toFixed(1)} cut ${same.toFixed(1)}`)
}

const ignored = build({ ...defaultSettings(), thingToMake: 'cutter' }, wideShort)
assert('cutter mode does not build a box', ignored.model == null)
assert('ignored build does not leak', ignored.leaked === 0)

disposeModel(plain.model)
disposeModel(noBattery.model)
disposeModel(tiny.model)
disposeModel(filtered.model)
disposeModel(cut.model)

if (failed > 0) {
  console.error(`${failed} lightbox check(s) failed`)
  process.exit(1)
}
console.log('lightbox geometry ok')
