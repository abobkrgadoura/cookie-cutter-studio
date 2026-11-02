/**
 * Tiny, allocation-light 2D path metrics used on the MAIN thread
 * (settings preview, SVG import, STL stamp placement). Kept free of
 * Clipper2 / manifold-3d / Three.js so slider drags never parse WASM
 * or pull the geometry stack onto the UI thread.
 */

export function computePathBounds(path) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const p of path) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(maxX - minX, 0),
    height: Math.max(maxY - minY, 0),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

export function computePathsBounds(paths) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const path of paths || []) {
    for (const p of path) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }

  if (minX === Infinity) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, cx: 0, cy: 0 }
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

/**
 * The scale `fitPathsToSize` applies. Drawings reuse this exact transform
 * so a stroke offset in millimetres lands in the fitted cavity without a
 * second fit (which would rescale the traced silhouette).
 */
export function measureFit(paths, targetWidth, targetHeight, keepAspect = true) {
  const b = computePathsBounds(paths)
  if (!(b.width > 0) || !(b.height > 0)) return null

  let sx = targetWidth / b.width
  let sy = targetHeight / b.height
  if (keepAspect) {
    const s = Math.min(sx, sy)
    sx = s
    sy = s
  }
  if (![sx, sy].every((value) => Number.isFinite(value) && value !== 0)) return null
  return { cx: b.cx, cy: b.cy, sx, sy }
}

export function applyFit(paths, fit) {
  if (!fit) return paths
  return paths.map((path) =>
    path.map((p) => ({
      x: (p.x - fit.cx) * fit.sx,
      y: (p.y - fit.cy) * fit.sy,
    })),
  )
}

export function fitPathsToSize(paths, targetWidth, targetHeight, keepAspect = true) {
  const fit = measureFit(paths, targetWidth, targetHeight, keepAspect)
  if (!fit) return paths
  return applyFit(paths, fit)
}

/**
 * Axis-aligned cavity size may miss the requested millimetres by at most
 * this much. Anything larger is a scale error (float, chord decimation,
 * or a clipper snap that actually moved an extremum) and is corrected
 * silently — no toast, no log.
 */
export const PATH_INTEGRITY_TOLERANCE_MM = 0.02

/**
 * Measure `paths` and scale them about the bounding-box center when the
 * box misses the size `fitPathsToSize` would have produced by more than
 * 0.02 mm.
 *
 * Aspect lock uses one multiplier, `min(targetWidth / width, targetHeight / height)`,
 * the same contract as `measureFit`. A locked silhouette that already
 * touches one requested side is left alone, so the short side is not
 * stretched and a one-sided edit is not inflated. Unlocked width and
 * height each get their own multiplier; a miss on either axis above the
 * tolerance scales both so the box lands on the request.
 *
 * Returns the same array when the error is inside the tolerance (or the
 * box is degenerate), so a caller can tell a real correction from a no-op
 * with reference equality. The center is preserved: this is a scale, not
 * a second centering pass.
 */
export function enforcePathDimensions(paths, targetWidth, targetHeight, keepAspect = true) {
  if (!paths?.length) return paths || []
  const width = Number(targetWidth)
  const height = Number(targetHeight)
  if (!(width > 0) || !(height > 0)) return paths

  const bounds = computePathsBounds(paths)
  if (!(bounds.width > 0) || !(bounds.height > 0)) return paths
  if (!Number.isFinite(bounds.cx) || !Number.isFinite(bounds.cy)) return paths

  let sx = width / bounds.width
  let sy = height / bounds.height
  if (keepAspect) {
    const s = Math.min(sx, sy)
    sx = s
    sy = s
  }
  if (![sx, sy].every((value) => Number.isFinite(value) && value > 0)) return paths

  const widthMiss = Math.abs(bounds.width * sx - bounds.width)
  const heightMiss = Math.abs(bounds.height * sy - bounds.height)
  if (!(widthMiss > PATH_INTEGRITY_TOLERANCE_MM) && !(heightMiss > PATH_INTEGRITY_TOLERANCE_MM)) {
    return paths
  }

  return paths.map((path) =>
    path.map((p) => ({
      x: bounds.cx + (p.x - bounds.cx) * sx,
      y: bounds.cy + (p.y - bounds.cy) * sy,
    })),
  )
}

/**
 * Uniformly scale `paths` so the whole bounding box fits inside `box`
 * after `margin` mm is removed from both sides of the box, then move the
 * artwork so its bounding-box center lies on the box center.
 *
 * Scale is `min(innerWidth / artWidth, innerHeight / artHeight)`. That is
 * the largest uniform scale whose longest side still lands inside the
 * inset rectangle, so a wide SVG cannot spill past the plate.
 * `box` is a `computePathsBounds` result (`width`, `height`, `cx`, `cy`).
 * Returns null when either span is degenerate or the margin consumes the box.
 */
export function fitPathsCenteredInBounds(paths, box, margin = 0) {
  if (!paths || paths.length === 0 || !box) return null
  const art = computePathsBounds(paths)
  if (!(art.width > 0) || !(art.height > 0)) return null
  if (!(box.width > 0) || !(box.height > 0)) return null
  if (!Number.isFinite(box.cx) || !Number.isFinite(box.cy)) return null

  const requested = Number.isFinite(margin) ? Math.max(margin, 0) : 0
  const maxMargin = Math.min(box.width, box.height) / 2 - 0.05
  const inset = Math.min(requested, Math.max(maxMargin, 0))
  const innerW = box.width - inset * 2
  const innerH = box.height - inset * 2
  if (!(innerW > 0) || !(innerH > 0)) return null

  const scale = Math.min(innerW / art.width, innerH / art.height)
  if (!Number.isFinite(scale) || !(scale > 0)) return null

  return paths.map((loop) =>
    loop.map((p) => ({
      x: box.cx + (p.x - art.cx) * scale,
      y: box.cy + (p.y - art.cy) * scale,
    })),
  )
}

/**
 * Stamp assembly always sits flush on the build plate (Z=0). Shared by
 * the viewer and STL export so the downloaded file matches the preview.
 */
export function computeStampZ(_settings) {
  return 0
}
