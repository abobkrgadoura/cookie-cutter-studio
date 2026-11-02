import { generateCirclePoints, generateDonutPoints, generateHeartPoints } from '../src/lib/presets.js'
import { buildStencilSheet, buildStencilSvg } from '../src/lib/stencilSheet.js'

function area(paths) {
  let a = 0
  for (const loop of paths) {
    let s = 0
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i]
      const q = loop[(i + 1) % loop.length]
      s += p.x * q.y - q.x * p.y
    }
    a += Math.abs(s / 2)
  }
  return a
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function pointInPaths(pt, paths) {
  let inside = false
  for (const poly of paths || []) {
    let hit = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i].y
      const yj = poly[j].y
      if (yi > pt.y !== yj > pt.y && pt.x < ((poly[j].x - poly[i].x) * (pt.y - yi)) / (yj - yi) + poly[i].x) {
        hit = !hit
      }
    }
    if (hit) inside = !inside
  }
  return inside
}

const base = {
  thingToMake: 'stencil',
  mirrorDesign: false,
  stencilBoardWidth: 220,
  stencilBoardHeight: 220,
  stencilMargin: 10,
  designWidth: 100,
  designHeight: 100,
  designAspectLocked: true,
  rows: 1,
  columns: 1,
  cutThickness: 2,
  stencilArtwork: 'filled',
  stencilBridges: true,
  bridgeWidth: 2,
  bridgeCount: 2,
  bridgeStrategy: 'even',
}

const donut = buildStencilSheet(generateDonutPoints(), base, null)
assert(donut.sourceIslands === 1, `donut islands before bridges = ${donut.sourceIslands}`)
assert(donut.openIslands === 0, `donut islands still loose = ${donut.openIslands}`)
assert(donut.cutPaths.length >= 1, 'donut produced no cuts')
for (const loop of donut.cutPaths) {
  for (const p of loop) {
    assert(Math.abs(p.x) <= 110.01 && Math.abs(p.y) <= 110.01, `cut left the sheet at ${p.x},${p.y}`)
  }
}

const heart = buildStencilSheet([generateHeartPoints()], { ...base, stencilArtwork: 'centerline', bridgeStrategy: 'shortest' }, [2])
const heartArea = area(heart.cutPaths)
assert(heartArea > 50 && heartArea < 2500, `centerline heart area ${heartArea} is not a gap`)
assert(heart.sourceIslands >= 1, 'centerline heart should enclose an island')
assert(heart.openIslands === 0, `centerline heart still loose: ${heart.openIslands}`)

const line = [
  [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
  ],
]
const stroked = buildStencilSheet(line, { ...base, designWidth: 80, designHeight: 20, stencilArtwork: 'auto' }, [1])
const lineArea = area(stroked.cutPaths)
assert(lineArea > 100 && lineArea < 400, `open stroke area ${lineArea}`)

const grid = buildStencilSheet(generateDonutPoints(), {
  ...base,
  stencilBoardWidth: 200,
  stencilBoardHeight: 200,
  designWidth: 40,
  designHeight: 40,
  rows: 2,
  columns: 2,
  bridgeCount: 1,
}, null)
assert(grid.rows === 2 && grid.columns === 2, 'grid size')
assert(grid.gapX > 1 && grid.gapY > 1, `gaps ${grid.gapX} ${grid.gapY}`)
assert(grid.openIslands === 0, `grid loose islands ${grid.openIslands}`)
assert(grid.cutPaths.length >= 2, `grid contours ${grid.cutPaths.length}`)

const overlap = buildStencilSheet(
  [
    [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 30 },
      { x: 0, y: 30 },
    ],
    [
      { x: 15, y: 15 },
      { x: 45, y: 15 },
      { x: 45, y: 45 },
      { x: 15, y: 45 },
    ],
  ],
  { ...base, stencilBridges: false, designWidth: 60, designHeight: 60 },
  [0, 0],
)
assert(overlap.cutPaths.length === 1, `overlapping cuts stayed split: ${overlap.cutPaths.length}`)
const svg = buildStencilSvg(overlap)
const pathCount = (svg.match(/<path /g) || []).length
assert(pathCount === 1, `svg path count ${pathCount}`)
assert(svg.includes('width="220mm"'), 'svg units')
assert(!svg.includes('fill="#'), 'cut file is not a filled preview')

const circle = buildStencilSheet([generateCirclePoints(50, 64)], { ...base, stencilArtwork: 'centerline' }, [2])
const circleArea = area(circle.cutPaths)
assert(circleArea > 200 && circleArea < 1200, `circle stroke area ${circleArea}`)
assert(circle.openIslands === 0, `circle island loose ${circle.openIslands}`)

const manualBase = { ...base, bridgeStrategy: 'manual', placement: 'manual', manualBridges: [] }
const loose = buildStencilSheet(generateDonutPoints(), manualBase, null)
assert(loose.openIslands === 1, `manual with no clicks still bridged: ${loose.openIslands}`)
assert(loose.sourceIslands === 1, `manual source islands ${loose.sourceIslands}`)

const right = buildStencilSheet(
  generateDonutPoints(),
  { ...manualBase, manualBridges: [{ x: 145, y: 110 }] },
  null,
)
assert(right.openIslands === 0, `manual right bridge left the island loose: ${right.openIslands}`)
assert(!pointInPaths({ x: 35, y: 0 }, right.cutPaths), 'right bridge missed the gap')
assert(pointInPaths({ x: -35, y: 0 }, right.cutPaths), 'right bridge also closed the opposite side')
assert(pointInPaths({ x: 35, y: 0 }, right.plasticPaths), 'right bridge was cut out of the plastic')
assert(pointInPaths({ x: 0, y: 0 }, right.plasticPaths), 'island fell out of the sheet')
assert(!pointInPaths({ x: -35, y: 0 }, right.plasticPaths), 'opposite gap was filled in the plastic')
const rightMarker = right.bridgeMarkers?.[0]
assert(rightMarker, 'missing right bridge marker')
assert(Math.abs(rightMarker.x + rightMarker.width / 2 - 145) < 0.5, `right marker x ${rightMarker.x}`)
assert(Math.abs(rightMarker.y + rightMarker.height / 2 - 110) < 0.5, `right marker y ${rightMarker.y}`)
assert(rightMarker.width > rightMarker.height, 'right bridge should run horizontally')
assert(Math.abs(rightMarker.height - base.bridgeWidth) < 0.05, `right thickness ${rightMarker.height}`)

const top = buildStencilSheet(
  generateDonutPoints(),
  { ...manualBase, manualBridges: [{ x: 110, y: 75 }] },
  null,
)
assert(top.openIslands === 0, `manual top bridge left the island loose: ${top.openIslands}`)
assert(!pointInPaths({ x: 0, y: 35 }, top.cutPaths), 'top bridge missed +Y')
assert(pointInPaths({ x: 0, y: -35 }, top.cutPaths), 'top bridge landed on -Y')
const topMarker = top.bridgeMarkers?.[0]
assert(topMarker && topMarker.height > topMarker.width, 'top bridge should run vertically')

const gridManual = buildStencilSheet(generateDonutPoints(), {
  ...manualBase,
  stencilBoardWidth: 200,
  stencilBoardHeight: 200,
  designWidth: 40,
  designHeight: 40,
  rows: 2,
  columns: 2,
  manualBridges: [{ x: 44, y: 170 }],
}, null)
assert(gridManual.openIslands === 3, `manual grid closed ${4 - gridManual.openIslands} islands, expected 1`)

console.log('stencil sheet checks passed', {
  donutContours: donut.cutPaths.length,
  heartArea: Math.round(heartArea),
  lineArea: Math.round(lineArea),
  gridContours: grid.cutPaths.length,
  gap: Math.round(grid.gapX * 10) / 10,
  circleArea: Math.round(circleArea),
  manualRight: `${Math.round(rightMarker.width * 10) / 10}x${Math.round(rightMarker.height * 10) / 10}`,
  manualGridLoose: gridManual.openIslands,
})
