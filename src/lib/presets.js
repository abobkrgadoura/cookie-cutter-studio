/**
 * Built-in parametric & vector presets with outer boundaries and holes.
 *
 * Analytic curves use the same finest parameter step as the SVG parser
 * (`SVG_MIN_DT = 1/512`) so preset walls are not coarser than imported art.
 * Straight-edged presets (star, polygon, gingerbread, tree) stay at one
 * vertex per corner — extra samples there would be collinear.
 */
const PRESET_CURVE_STEPS = 512

export function generateHeartPoints(steps = PRESET_CURVE_STEPS) {
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const x = 16 * Math.sin(t) ** 3
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
    pts.push({ x, y })
  }
  return pts
}

export function generateStarPoints(points = 5, outerR = 50, innerR = 24) {
  const pts = []
  const count = points * 2
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2
    const r = i % 2 === 0 ? outerR : innerR
    pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r })
  }
  return pts
}

export function generateCirclePoints(r = 50, steps = PRESET_CURVE_STEPS) {
  const pts = []
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2
    pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r })
  }
  return pts
}

export function generatePolygonPoints(sides = 6, r = 50) {
  const pts = []
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2
    pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r })
  }
  return pts
}

export function generateFlowerPoints(petals = 6, outerR = 50, innerR = 34, steps = PRESET_CURVE_STEPS) {
  const pts = []
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2
    const r = innerR + (outerR - innerR) * (0.5 + 0.5 * Math.cos(angle * petals))
    pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r })
  }
  return pts
}

export function generateGingerbreadPoints() {
  return [
    { x: 0, y: -45 }, { x: 12, y: -43 }, { x: 20, y: -35 }, { x: 18, y: -24 },
    { x: 12, y: -18 }, { x: 30, y: -16 }, { x: 42, y: -10 }, { x: 44, y: 0 },
    { x: 34, y: 8 }, { x: 18, y: 5 }, { x: 15, y: 18 }, { x: 26, y: 38 },
    { x: 24, y: 48 }, { x: 10, y: 48 }, { x: 4, y: 28 }, { x: 0, y: 22 },
    { x: -4, y: 28 }, { x: -10, y: 48 }, { x: -24, y: 48 }, { x: -26, y: 38 },
    { x: -15, y: 18 }, { x: -18, y: 5 }, { x: -34, y: 8 }, { x: -44, y: 0 },
    { x: -42, y: -10 }, { x: -30, y: -16 }, { x: -12, y: -18 }, { x: -18, y: -24 },
    { x: -20, y: -35 }, { x: -12, y: -43 }
  ]
}

export function generateTreePoints() {
  return [
    { x: 0, y: -48 }, { x: 15, y: -32 }, { x: 8, y: -30 }, { x: 24, y: -12 },
    { x: 15, y: -10 }, { x: 34, y: 15 }, { x: 8, y: 15 }, { x: 8, y: 36 },
    { x: -8, y: 36 }, { x: -8, y: 15 }, { x: -34, y: 15 }, { x: -15, y: -10 },
    { x: -24, y: -12 }, { x: -8, y: -30 }, { x: -15, y: -32 }
  ]
}

export function generateDonutPoints() {
  // Outer circle and inner circle hole
  const outer = generateCirclePoints(50)
  const inner = generateCirclePoints(20).reverse() // Clockwise hole
  return [outer, inner]
}

export const PRESET_SHAPES = [
  { id: 'heart', name: 'Heart Silhouette', getPaths: () => [generateHeartPoints()] },
  { id: 'star', name: 'Five-Point Star', getPaths: () => [generateStarPoints(5, 50, 24)] },
  { id: 'gingerbread', name: 'Gingerbread Person', getPaths: () => [generateGingerbreadPoints()] },
  { id: 'flower', name: 'Spring Flower', getPaths: () => [generateFlowerPoints(6, 50, 32)] },
  { id: 'tree', name: 'Pine Tree', getPaths: () => [generateTreePoints()] },
  { id: 'donut', name: 'Donut with Hole', getPaths: () => generateDonutPoints() },
  { id: 'hexagon', name: 'Honeycomb Hexagon', getPaths: () => [generatePolygonPoints(6, 50)] },
  { id: 'circle', name: 'Classic Round', getPaths: () => [generateCirclePoints(50)] },
]

/** Battery pack seated in the lightbox base. `'None'` is a hollow pillar only. */
export const LIGHTBOX_BATTERY_OPTIONS = [
  { value: '2xAAA', label: '2xAAA' },
  { value: 'None', label: 'None' },
]

/**
 * Printable parts the user can include in a download. `walls` is the four
 * stencil faces; the rest are optional so a reprint can be walls only.
 * A fresh object each call so one design cannot mutate another's flags.
 */
export function defaultLightboxExportParts() {
  return {
    walls: true,
    base: true,
    pillar: true,
    imagePlate: true,
  }
}

/**
 * Meshes `buildLightboxGeometry` returns. `exportParts.walls` covers the
 * four plates. The aura is cut from `wallFront`; there is no separate
 * image-plate solid yet.
 */
export const LIGHTBOX_MESH_KEYS = ['base', 'pillar', 'wallFront', 'wallBack', 'wallLeft', 'wallRight']

/**
 * Shadow Projection Lightbox defaults, in millimetres. Spread into
 * `defaultSettings()` so React state, saved profiles, and the sidebar
 * share one source. `buildLightboxGeometry` builds the plates from these.
 */
export function defaultLightboxSettings() {
  return {
    boxWidth: 120,
    boxHeight: 150,
    boxDepth: 50,
    wallThickness: 2,
    batteryType: '2xAAA',
    exportParts: defaultLightboxExportParts(),
  }
}
