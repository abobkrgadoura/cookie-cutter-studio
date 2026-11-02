import {
  editorEntitiesToTraceStrokes,
  entitiesBounds,
  entityGroupIds,
  isFilledEntity,
  normalizeLineStyle,
  scaleEntitiesToSize,
} from './src/lib/vectorEntities.js'
import { BASE_GROUP_ID, isBasePristine, tracePathsToBaseEntities } from './src/lib/vectorBase.js'
import { eraseEntities } from './src/lib/vectorErase.js'
import {
  buildDragPrimitive,
  circlePoints,
  dashCutSegments,
  rectanglePoints,
} from './src/lib/vectorPrimitives.js'
import { unionDrawingStrokes } from './src/lib/vectorStroke.js'

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

function chainLength(points) {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return length
}

const rect = rectanglePoints({ x: 1, y: 5 }, { x: 4, y: 2 })
assert(rect.length === 4, 'rectangle has 4 corners')
assert(rect[0].x === 1 && rect[0].y === 2, 'rectangle origin is min corner')
assert(rect[2].x === 4 && rect[2].y === 5, 'rectangle opposite corner is max')
assert(Math.abs(signedArea(rect) - 9) < 1e-9, 'rectangle area')

const circle = circlePoints({ x: 3, y: -4 }, 10, 64)
assert(circle.length === 64, 'circle has 64 vertices')
assert(Math.abs(Math.hypot(circle[0].x - 3, circle[0].y + 4) - 10) < 1e-9, 'circle starts at angle 0')
for (const p of circle) {
  const radius = Math.hypot(p.x - 3, p.y + 4)
  assert(Math.abs(radius - 10) < 1e-9, 'circle radius')
}
assert(Math.hypot(circle[0].x - circle[63].x, circle[0].y - circle[63].y) > 0.5, 'circle does not repeat the first vertex')

const line = buildDragPrimitive('line', { x: 0, y: 0 }, { x: 4, y: 0 }, 1)
assert(line && !line.closed && line.points.length === 2, 'line primitive')
assert(buildDragPrimitive('line', { x: 0, y: 0 }, { x: 0.2, y: 0 }, 1) === null, 'short line is rejected')
const box = buildDragPrimitive('rect', { x: 0, y: 0 }, { x: 8, y: 3 }, 1)
assert(box && box.closed && box.points.length === 4, 'rect primitive')
const round = buildDragPrimitive('circle', { x: 0, y: 0 }, { x: 5, y: 0 }, 1)
assert(round && round.closed && round.points.length === 64, 'circle primitive')

const openCuts = dashCutSegments(
  [
    { x: 0, y: 0 },
    { x: 14, y: 0 },
  ],
  false,
  5,
  2,
)
assert(openCuts.length === 2, `open dash count ${openCuts.length}`)
assert(Math.abs(chainLength(openCuts[0]) - 5) < 1e-6, 'first cut is 5')
assert(Math.abs(chainLength(openCuts[1]) - 5) < 1e-6, 'second cut is 5')
assert(Math.abs(openCuts[0][0].x) < 1e-6 && Math.abs(openCuts[1][0].x - 7) < 1e-6, 'gap of 2 separates cuts')

const short = dashCutSegments(
  [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
  ],
  false,
  5,
  2,
)
assert(short.length === 1 && Math.abs(chainLength(short[0]) - 3) < 1e-6, 'short path stays one cut')

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]
const loopCuts = dashCutSegments(square, true, 5, 2)
const cutSum = loopCuts.reduce((sum, seg) => sum + chainLength(seg), 0)
assert(loopCuts.length === 6, `closed dash count ${loopCuts.length}`)
assert(Math.abs(cutSum - 30) < 1e-4, `closed cut length ${cutSum}`)

const fit = { cx: 0, cy: 0, sx: 1, sy: 1 }
const dashed = unionDrawingStrokes(
  [],
  [
    {
      closed: false,
      strokeWidth: 1,
      lineStyle: 'dashed',
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
    },
  ],
  fit,
  false,
)
assert(dashed.length >= 3, `dashed offset produced ${dashed.length} loops`)

const solid = unionDrawingStrokes(
  [],
  [
    {
      closed: false,
      strokeWidth: 1,
      lineStyle: 'solid',
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
    },
  ],
  fit,
  false,
)
assert(solid.length >= 1, 'solid stroke still offsets')

const outer = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]
const hole = [
  { x: 2, y: 2 },
  { x: 2, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 2 },
]
assert(signedArea(outer) > 0, 'fixture outer is positive')
assert(signedArea(hole) < 0, 'fixture hole is negative')
const traced = editorEntitiesToTraceStrokes([
  { points: outer, holes: [hole], baked: true, closed: true, strokeWidth: 1.5 },
])
assert(traced.length === 2, 'baked outer and hole both export')
assert(signedArea(traced[0].points) > 0, 'exported outer stays positive after Y flip')
assert(signedArea(traced[1].points) < 0, 'exported hole stays negative after Y flip')
assert(traced[0].baked && traced[0].lineStyle === 'solid', 'baked export is a fill')

const centerline = [
  {
    id: 'stroke',
    type: 'path',
    points: [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ],
    closed: false,
    strokeWidth: 4,
    lineStyle: 'solid',
  },
]
const missed = eraseEntities(centerline, { x: 40, y: 100 }, 2, 1)
assert(missed === centerline, 'a miss keeps the original entities')

const bitten = eraseEntities(centerline, { x: 40, y: 0 }, 8, 1)
assert(bitten !== centerline, 'a hit returns new entities')
assert(bitten.length >= 1, 'a bite leaves material')
assert(bitten.every((entity) => entity.baked && entity.closed), 'a bite bakes the remaining fill')
assert(bitten.some((entity) => entity.id === 'stroke'), 'the largest leftover keeps its id')

const filled = [
  {
    id: 'pad',
    type: 'region',
    points: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ],
    holes: [],
    closed: true,
    baked: true,
    strokeWidth: 2,
    lineStyle: 'solid',
  },
]
const punched = eraseEntities(filled, { x: 20, y: 20 }, 6, 1)
assert(punched.length === 1 && punched[0].id === 'pad', 'a punch stays one region')
assert(punched[0].holes?.length === 1, 'a punch keeps the opening as a hole')
assert(signedArea(punched[0].points) > 0, 'punched outer stays positive')
assert(signedArea(punched[0].holes[0]) < 0, 'punched hole stays negative')

// ---------------------------------------------------------------------------
// Filled style
// ---------------------------------------------------------------------------
assert(normalizeLineStyle('filled') === 'filled', 'filled is a valid line style')
assert(normalizeLineStyle('dashed') === 'dashed' && normalizeLineStyle('nope') === 'solid', 'other styles unchanged')
assert(isFilledEntity({ lineStyle: 'filled', points: [{}, {}, {}] }), 'three-point filled entity is a fill')
assert(!isFilledEntity({ lineStyle: 'filled', points: [{}, {}] }), 'two-point filled entity has no area')
assert(isFilledEntity({ baked: true, points: [{}, {}, {}] }), 'baked is always a fill')

const filledStroke = editorEntitiesToTraceStrokes([
  { points: rectanglePoints({ x: 0, y: 0 }, { x: 10, y: 6 }), closed: true, strokeWidth: 3, lineStyle: 'filled' },
])
assert(filledStroke.length === 1 && filledStroke[0].lineStyle === 'filled', 'filled style survives the CAM export')

// A filled rectangle is the exact rectangle: no stroke band is added around it.
const filledCav = unionDrawingStrokes([], filledStroke, fit, false)
const filledArea = filledCav.reduce((sum, loop) => sum + signedArea(loop), 0)
assert(Math.abs(filledArea - 60) < 1e-3, `filled region area is exactly the outline (${filledArea})`)
assert(filledCav.every((loop) => signedArea(loop) > 0), 'filled region is outer-positive')

// Clockwise and mirrored input fills the same area.
const cwFilled = unionDrawingStrokes(
  [],
  [{ closed: true, strokeWidth: 3, lineStyle: 'filled', points: rectanglePoints({ x: 0, y: 0 }, { x: 10, y: 6 }).reverse() }],
  fit,
  true,
)
assert(Math.abs(cwFilled.reduce((sum, loop) => sum + signedArea(loop), 0) - 60) < 1e-3, 'reversed + mirrored fill keeps its area')

// A filled shape inside a window of the cavity becomes an island, not a hole.
const windowed = unionDrawingStrokes(
  [outer, hole],
  [{ closed: true, strokeWidth: 1, lineStyle: 'filled', points: rectanglePoints({ x: 2.5, y: 2.5 }, { x: 3.5, y: 3.5 }) }],
  fit,
  false,
)
assert(windowed.reduce((sum, loop) => sum + signedArea(loop), 0) > 100 - 4 + 0.99, 'filled stamp fills part of a window')

// A filled shape is erased as an area, not as a stroke band.
const filledShape = [
  {
    id: 'f',
    type: 'rect',
    points: rectanglePoints({ x: 0, y: 0 }, { x: 40, y: 40 }),
    closed: true,
    strokeWidth: 8,
    lineStyle: 'filled',
  },
]
const filledMiss = eraseEntities(filledShape, { x: 60, y: 20 }, 4, 1)
assert(filledMiss === filledShape, 'a disk beyond a filled edge misses (stroke width is not a margin)')
const filledPunch = eraseEntities(filledShape, { x: 20, y: 20 }, 6, 1)
assert(filledPunch.length === 1 && filledPunch[0].holes.length === 1, 'erasing inside a fill punches a hole')
assert(filledPunch[0].lineStyle === 'filled' && filledPunch[0].baked, 'the bitten fill stays filled')

// ---------------------------------------------------------------------------
// Exact dimensions
// ---------------------------------------------------------------------------
const scalable = [
  { id: 'a', points: rectanglePoints({ x: 10, y: 20 }, { x: 30, y: 40 }), closed: true },
  { id: 'b', points: rectanglePoints({ x: 100, y: 100 }, { x: 110, y: 110 }), closed: true },
]
const before = entitiesBounds(scalable, ['a'])
assert(before.width === 20 && before.height === 20 && before.cx === 20 && before.cy === 30, 'bounds of an entity')
const grown = scaleEntitiesToSize(scalable, ['a'], 50, 10)
const after = entitiesBounds(grown, ['a'])
assert(Math.abs(after.width - 50) < 1e-9 && Math.abs(after.height - 10) < 1e-9, 'scaled to the exact size')
assert(Math.abs(after.cx - 20) < 1e-9 && Math.abs(after.cy - 30) < 1e-9, 'scale keeps the bounding-box centre')
assert(grown[1] === scalable[1], 'unlisted entities are untouched')
assert(scaleEntitiesToSize(scalable, ['a'], 20, 20) === scalable, 'same size returns the same array')
assert(scaleEntitiesToSize(scalable, ['a'], 0, NaN) === scalable, 'zero / NaN targets are ignored')
const widthOnly = scaleEntitiesToSize(scalable, ['a'], 40, NaN)
const widthOnlyBounds = entitiesBounds(widthOnly, ['a'])
assert(Math.abs(widthOnlyBounds.width - 40) < 1e-9 && widthOnlyBounds.height === 20, 'one axis can scale alone')
const flat = [{ id: 'l', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }]
const flatScaled = entitiesBounds(scaleEntitiesToSize(flat, ['l'], 20, 5), ['l'])
assert(Math.abs(flatScaled.width - 20) < 1e-9 && flatScaled.height === 0, 'a flat line cannot gain height')
const holed = [{ id: 'h', points: outer, holes: [hole], closed: true, baked: true }]
const holedScaled = scaleEntitiesToSize(holed, ['h'], 20, 20)
assert(
  Math.abs(entitiesBounds(holedScaled, ['h']).width - 20) < 1e-9 && Math.abs(signedArea(holedScaled[0].holes[0]) + 16) < 1e-9,
  'holes scale with their outer (2x per axis: hole area 4 -> 16)',
)
// Typing a size in steps lands on the exact final value with no drift.
let walked = scalable
for (const target of [1, 12, 123, 12.5, 25]) walked = scaleEntitiesToSize(walked, ['a'], target, target)
const walkedBounds = entitiesBounds(walked, ['a'])
assert(Math.abs(walkedBounds.width - 25) < 1e-9 && Math.abs(walkedBounds.cx - 20) < 1e-9, 'stepwise typing has no drift')

// ---------------------------------------------------------------------------
// Editable base silhouette
// ---------------------------------------------------------------------------
// Tracer space is Y up with outer positive and hole negative. Use that, plus a
// second island and an island inside the hole.
const tracerOuter = outer.map((p) => ({ x: p.x * 10, y: -p.y * 10 })).reverse()
const tracerHole = hole.map((p) => ({ x: p.x * 10, y: -p.y * 10 })).reverse()
const tracerIsland = rectanglePoints({ x: 24, y: 24 }, { x: 26, y: 26 }).map((p) => ({ x: p.x, y: -p.y }))
const tracerSecond = rectanglePoints({ x: 200, y: 0 }, { x: 230, y: 30 }).map((p) => ({ x: p.x, y: -p.y }))
assert(signedArea(tracerOuter) > 0, 'fixture: tracer outer is positive')
assert(signedArea(tracerHole) < 0, 'fixture: tracer hole is negative')

const paths = [tracerOuter, tracerHole, tracerIsland, tracerSecond]
const base = tracePathsToBaseEntities(paths)
assert(base.length === 3, `outer + island-in-hole + second blob make 3 regions (got ${base.length})`)
assert(base.every((e) => e.base && e.baked && e.closed && e.groupId === BASE_GROUP_ID), 'base regions are flagged and grouped')
assert(base[0].holes.length === 1, 'the hole lives on its host outer')
assert(base.every((e) => signedArea(e.points) > 0), 'base outers are positive in editor space')
assert(signedArea(base[0].holes[0]) < 0, 'base hole is negative in editor space')
assert(entityGroupIds(base, base[2].id).length === 3, 'every island selects as one group')
assert(entityGroupIds([...base, { id: 'x', points: [] }], 'x').length === 1, 'an ungrouped entity selects alone')

// Winding must not decide outer vs hole: feed the same loops reversed.
const reversedBase = tracePathsToBaseEntities(paths.map((ring) => ring.slice().reverse()))
assert(reversedBase.length === 3 && reversedBase[0].holes.length === 1, 'classification is winding-independent')

// The silhouette survives the round trip to the cutter vertex for vertex (Rule 1).
const exported = editorEntitiesToTraceStrokes(base)
const exportedOuter = exported.find((stroke) => stroke.points.length === tracerOuter.length && signedArea(stroke.points) > 0)
assert(exportedOuter, 'outer exports back with its vertex count')
const sameRing = exportedOuter.points.every((p, i) => p.x === tracerOuter[i].x && p.y === tracerOuter[i].y)
assert(sameRing, 'exported outer equals the traced outer, same order, bit for bit')
const exportedHole = exported.find((stroke) => signedArea(stroke.points) < 0)
assert(
  exportedHole.points.every((p, i) => p.x === tracerHole[i].x && p.y === tracerHole[i].y),
  'exported hole equals the traced hole, bit for bit',
)

// Pristine tracking drives whether the cutter keeps the original fit path.
assert(isBasePristine(base, base), 'untouched base is pristine')
const restyled = base.map((e) => ({ ...e, strokeWidth: 9, lineStyle: 'solid' }))
assert(isBasePristine(restyled, base), 'restyling keeps the geometry pristine')
const moved = base.map((e, i) => (i === 0 ? { ...e, points: e.points.map((p) => ({ x: p.x + 1, y: p.y })) } : e))
assert(!isBasePristine(moved, base), 'moving a region makes the base dirty')
assert(!isBasePristine(base.slice(1), base), 'deleting a region makes the base dirty')

// Erasing the silhouette keeps it a silhouette, and split islands stay grouped.
const bittenBase = eraseEntities(base, { x: 100, y: 60 }, 30, 1)
assert(bittenBase !== base, 'eraser bites the base')
assert(bittenBase.every((e) => e.base && e.groupId === BASE_GROUP_ID), 'erased pieces stay in the base group')
assert(!isBasePristine(bittenBase.filter((e) => e.base), base), 'erasing makes the base dirty')

// replaceBase: the original trace no longer contributes, the edits are the cavity.
const baseFit = { cx: 0, cy: 0, sx: 0.1, sy: 0.1 }
const traceFitted = [tracerOuter.map((p) => ({ x: p.x * 0.1, y: p.y * 0.1 }))]
const kept = unionDrawingStrokes(traceFitted, [], baseFit, false)
assert(kept.length === 1, 'without replaceBase the fitted trace is returned')
const gone = unionDrawingStrokes(traceFitted, [], baseFit, false, { replaceBase: true })
assert(gone.length === 0, 'replaceBase with nothing left is an empty cavity')
const edited = unionDrawingStrokes(traceFitted, editorEntitiesToTraceStrokes([base[0]]), baseFit, false, { replaceBase: true })
assert(edited.length === 2, 'replaceBase returns the edited outer + hole untouched')
const editedArea = edited.reduce((sum, loop) => sum + signedArea(loop), 0)
assert(Math.abs(editedArea - (10000 - 400) * 0.01) < 1e-6, `edited cavity area is outer minus hole (${editedArea})`)
const stamped = unionDrawingStrokes(
  traceFitted,
  [
    ...editorEntitiesToTraceStrokes([base[0]]),
    ...editorEntitiesToTraceStrokes([
      { points: rectanglePoints({ x: 15, y: 15 }, { x: 45, y: 45 }), closed: true, strokeWidth: 1, lineStyle: 'filled' },
    ]),
  ],
  baseFit,
  false,
  { replaceBase: true },
)
assert(
  stamped.every((loop) => signedArea(loop) > 0) && stamped.length === 1,
  `a filled stamp over the window fills it into one merged outline (${stamped.length} loops)`,
)
assert(Math.abs(stamped.reduce((sum, loop) => sum + signedArea(loop), 0) - 100) < 1e-3, 'stamped cavity is the full 10x10 mm')

console.log('vector tool checks passed')
