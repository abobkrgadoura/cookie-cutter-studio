// Verifies `sanitizeCutterWall`'s shrink-wrap envelope behavior in isolation
// (no need to go through the full `generateFullCutterModel` pipeline).
//
// Synthetic shape: a 40x20mm body with a narrow, ~V-shaped slot notch cut
// up into it from the bottom edge (2mm wide at its tip, 6mm wide at its
// mouth, 17mm deep) — a stand-in for the tight V-gap between two ribbon
// tails on the pacifier bow. `PROBE` sits deep inside that notch, in what
// should read as "outside the shape" (carved-out background) until the
// notch is fully bridged by the envelope.
import { sanitizeCutterWall, computePathsBounds } from './src/lib/clipperWrapper.js'

function bowWithNotch() {
  return [
    { x: -20, y: -20 },
    { x: -3, y: -20 },
    { x: -1, y: -3 },
    { x: 1, y: -3 },
    { x: 3, y: -20 },
    { x: 20, y: -20 },
    { x: 20, y: 0 },
    { x: -20, y: 0 },
  ]
}

// Even-odd point-in-polygon, tested against every loop `sanitizeCutterWall`
// returns (should only ever be one, but check all defensively).
function isInside(pt, paths) {
  return paths.some((poly) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y
      const xj = poly[j].x, yj = poly[j].y
      if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
    return inside
  })
}

const PROBE = { x: 0, y: -10 } // deep inside the notch's carved-out gap

function run(label, meltRadius) {
  const raw = bowWithNotch()
  const result = sanitizeCutterWall([raw], meltRadius)
  const bounds = computePathsBounds(result)
  const bridged = isInside(PROBE, result)
  const totalPts = result.reduce((n, p) => n + p.length, 0)
  console.log(
    label.padEnd(38),
    'loops:', result.length,
    'pts:', totalPts,
    'bbox:', bounds.width.toFixed(2) + 'x' + bounds.height.toFixed(2),
    'notch bridged:', bridged ? 'YES' : 'no',
  )
}

// Small radius — simulates a thin-blade / no-handle "cutter" setting,
// where `computeRequiredMeltRadiusMm` in cutterGeometry.js can shrink to
// close to just `bladeThickness + MELT_RADIUS_SAFETY_MARGIN_MM`.
run('meltRadius=0.6 (thin-wall safety floor)', 0.6)
// The old hardcoded default.
run('meltRadius=1.5 (old default)', 1.5)
// A "generous" wall-thickness-driven radius (default blade+handle settings).
run('meltRadius=5.0 (typical default settings)', 5.0)
