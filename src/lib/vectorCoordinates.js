/**
 * Screen ↔ vector-canvas mapping.
 *
 * The image layer is CSS `translate(pan) scale(zoom)` with the origin at
 * the viewport center. The SVG that sits on the image then maps that layer
 * through its viewBox. `clientToSvgUser` inverts the composed matrix
 * (pan, zoom, and viewBox) via the SVG screen CTM. The rect fallback is
 * the same inverse when the CTM is singular: the bounding rect is already
 * the transformed box, so the viewBox ratio undoes pan and zoom together.
 */

export function invertCenterPanZoom(offsetX, offsetY, pan, zoom) {
  const z = Number(zoom)
  const ox = Number(offsetX)
  const oy = Number(offsetY)
  if (!(z > 0) || !Number.isFinite(ox) || !Number.isFinite(oy)) return null
  const panX = Number(pan?.x) || 0
  const panY = Number(pan?.y) || 0
  return {
    x: (ox - panX) / z,
    y: (oy - panY) / z,
  }
}

export function clientToSvgUser(svg, clientX, clientY) {
  if (!svg) return null
  const ctm = svg.getScreenCTM?.()
  if (ctm && svg.createSVGPoint) {
    try {
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const local = pt.matrixTransform(ctm.inverse())
      if (Number.isFinite(local.x) && Number.isFinite(local.y)) {
        return { x: local.x, y: local.y }
      }
    } catch {
      // Singular screen matrix: fall through to the viewBox ratio.
    }
  }
  const bounds = svg.getBoundingClientRect?.()
  const view = svg.viewBox?.baseVal
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null
  const vx = view?.width > 0 ? view.x : 0
  const vy = view?.height > 0 ? view.y : 0
  const vw = view?.width > 0 ? view.width : bounds.width
  const vh = view?.height > 0 ? view.height : bounds.height
  return {
    x: vx + ((clientX - bounds.left) / bounds.width) * vw,
    y: vy + ((clientY - bounds.top) / bounds.height) * vh,
  }
}

/** How many SVG user units correspond to one screen pixel. Used for hit slop. */
export function svgUnitsPerScreenPixel(svg) {
  const ctm = svg?.getScreenCTM?.()
  if (!ctm) return 1
  const scale = Math.hypot(ctm.a, ctm.b)
  if (!(scale > 0)) return 1
  return 1 / scale
}
