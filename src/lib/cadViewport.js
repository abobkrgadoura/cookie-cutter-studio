/** Wheel step for the 2D sheet. Greater than 1 zooms out (viewBox grows). */
const WHEEL_FACTOR = 1.12

export function fittedSheetView(boardW, boardH, viewportW, viewportH) {
  const bw = Number(boardW)
  const bh = Number(boardH)
  const vw = Number(viewportW)
  const vh = Number(viewportH)
  if (![bw, bh, vw, vh].every(Number.isFinite)) return null
  if (!(bw > 0) || !(bh > 0) || !(vw > 0) || !(vh > 0)) return null
  const pad = 0.08
  const contentW = bw * (1 + pad * 2)
  const contentH = bh * (1 + pad * 2)
  const viewAspect = vw / vh
  const contentAspect = contentW / contentH
  let w
  let h
  if (viewAspect > contentAspect) {
    h = contentH
    w = contentH * viewAspect
  } else {
    w = contentW
    h = contentW / viewAspect
  }
  if (![w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) return null
  return {
    x: (bw - w) / 2,
    y: (bh - h) / 2,
    w,
    h,
  }
}

export function sheetZoomLimits(boardW, boardH) {
  const span = Math.max(Number(boardW) || 1, Number(boardH) || 1)
  return { minW: Math.max(span / 40, 0.5), maxW: span * 24, span }
}

export function clampView(view, span) {
  if (!view) return view
  const limit = Math.max(Number(span) || 1, 1) * 48
  const x = Number(view.x)
  const y = Number(view.y)
  const w = Number(view.w)
  const h = Number(view.h)
  if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) return view
  return {
    x: Math.min(limit, Math.max(-limit, x)),
    y: Math.min(limit, Math.max(-limit, y)),
    w,
    h,
  }
}

/** Shrink or grow the viewBox around a sheet-space point so that point stays under the cursor. */
export function zoomViewBoxAt(view, x, y, zoomIn, minW, maxW) {
  if (!view) return view
  const px = Number(x)
  const py = Number(y)
  if (!Number.isFinite(px) || !Number.isFinite(py)) return view
  if (!(view.w > 0) || !(view.h > 0)) return view
  const factor = zoomIn ? 1 / WHEEL_FACTOR : WHEEL_FACTOR
  let nextW = view.w * factor
  const lo = Number(minW) > 0 ? Number(minW) : view.w
  const hi = Number(maxW) > lo ? Number(maxW) : Math.max(view.w, lo)
  nextW = Math.min(hi, Math.max(lo, nextW))
  if (!Number.isFinite(nextW) || !(nextW > 0)) return view
  const applied = nextW / view.w
  const nextH = view.h * applied
  const u = (px - view.x) / view.w
  const v = (py - view.y) / view.h
  return {
    x: px - u * nextW,
    y: py - v * nextH,
    w: nextW,
    h: nextH,
  }
}

export function panViewBy(view, dx, dy) {
  if (!view) return view
  const x = Number(dx)
  const y = Number(dy)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return view
  return { ...view, x: view.x - x, y: view.y - y }
}

export function viewBoxAttr(view) {
  const n = (value) => {
    const num = Number(value)
    return Number.isFinite(num) ? num.toFixed(4) : '0'
  }
  if (!view || !(view.w > 0) || !(view.h > 0)) return '0 0 1 1'
  return `${n(view.x)} ${n(view.y)} ${n(view.w)} ${n(view.h)}`
}

export function clampScreenZoom(zoom) {
  const next = Number(zoom)
  if (!Number.isFinite(next)) return 1
  return Math.min(16, Math.max(0.15, next))
}

/**
 * Keep the sheet point under the cursor fixed.
 * `transform: translate(pan) scale(zoom)` with origin at the viewport center
 * applies scale first, so pan is in screen pixels.
 */
function clampPanPoint(pan) {
  const limit = 20000
  const x = Number(pan?.x)
  const y = Number(pan?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 }
  return {
    x: Math.min(limit, Math.max(-limit, x)),
    y: Math.min(limit, Math.max(-limit, y)),
  }
}

export function zoomScreenAt(pan, zoom, offsetX, offsetY, zoomIn) {
  const current = clampScreenZoom(zoom)
  const origin = clampPanPoint(pan)
  const factor = zoomIn ? WHEEL_FACTOR : 1 / WHEEL_FACTOR
  const next = clampScreenZoom(current * factor)
  const k = current > 0 ? next / current : 1
  const ox = Number(offsetX)
  const oy = Number(offsetY)
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(k)) {
    return { zoom: next, pan: origin }
  }
  return {
    zoom: next,
    pan: clampPanPoint({
      x: ox - (ox - origin.x) * k,
      y: oy - (oy - origin.y) * k,
    }),
  }
}
