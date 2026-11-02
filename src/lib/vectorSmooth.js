/**
 * Freehand cleanup. Raw pointer samples are dense and shaky. Chaikin
 * corner-cutting rounds the polyline, then an arc-length resample puts
 * vertices back on a steady spacing so the stroke offset does not inherit
 * a point cloud.
 */

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function dropNearDuplicates(points, minDist) {
  if (!points?.length) return []
  const limit = Math.max(Number(minDist) || 0, 0)
  const out = [{ x: points[0].x, y: points[0].y }]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (dist(out[out.length - 1], p) >= limit) out.push({ x: p.x, y: p.y })
  }
  return out
}

/** Open Chaikin. Endpoints stay put so the stroke still starts and ends where the pointer did. */
export function chaikinOpen(points, iterations = 2) {
  let current = points
  const passes = Math.max(0, iterations | 0)
  for (let pass = 0; pass < passes; pass++) {
    if (!current || current.length < 2) break
    const next = [{ x: current[0].x, y: current[0].y }]
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i]
      const b = current[i + 1]
      next.push({
        x: 0.75 * a.x + 0.25 * b.x,
        y: 0.75 * a.y + 0.25 * b.y,
      })
      next.push({
        x: 0.25 * a.x + 0.75 * b.x,
        y: 0.25 * a.y + 0.75 * b.y,
      })
    }
    const last = current[current.length - 1]
    next.push({ x: last.x, y: last.y })
    current = next
  }
  return current
}

/** Walk the polyline and emit a vertex every `spacing` units, keeping the final point. */
export function resamplePolyline(points, spacing) {
  if (!points?.length) return []
  if (points.length === 1 || !(spacing > 0)) {
    return points.map((p) => ({ x: p.x, y: p.y }))
  }
  const out = [{ x: points[0].x, y: points[0].y }]
  let prev = points[0]
  let remain = spacing
  for (let i = 1; i < points.length; i++) {
    let curr = points[i]
    let seg = dist(prev, curr)
    if (seg < 1e-9) continue
    while (seg + 1e-9 >= remain) {
      const t = remain / seg
      const nx = prev.x + (curr.x - prev.x) * t
      const ny = prev.y + (curr.y - prev.y) * t
      out.push({ x: nx, y: ny })
      prev = { x: nx, y: ny }
      curr = points[i]
      seg = dist(prev, curr)
      remain = spacing
      if (seg < 1e-9) break
    }
    remain -= seg
    prev = points[i]
  }
  const last = points[points.length - 1]
  const tail = out[out.length - 1]
  if (dist(tail, last) > spacing * 0.25) out.push({ x: last.x, y: last.y })
  return out
}

/**
 * Smooth a freehand sample in the editor's pixel frame.
 * `spacing` is in the same units as the points (trace pixels).
 */
export function smoothFreehand(points, spacing = 1.5) {
  const cleaned = dropNearDuplicates(points, Math.min(0.6, spacing * 0.35))
  if (cleaned.length < 3) return cleaned
  return resamplePolyline(chaikinOpen(cleaned, 2), spacing)
}
