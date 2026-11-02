import { useCallback, useEffect, useRef, useState } from 'react'
import { useModel } from '../../context/useModel.js'
import { useSettings } from '../../context/useSettings.js'
import { useVectorEditor } from '../../context/useVectorEditor.js'
import {
  clampView,
  fittedSheetView,
  panViewBy,
  sheetZoomLimits,
  viewBoxAttr,
  zoomViewBoxAt,
} from '../../lib/cadViewport.js'
import {
  MIN_MANUAL_BRIDGE_LENGTH,
  buildStencilPreviewD,
  isManualBridgePlacement,
  orientedBridgeRect,
  sheetPointInReach,
} from '../../lib/stencilSheet.js'
import { formatDim } from '../../lib/units.js'
import { isPanGesture, useSpacePanKey } from './useSpacePanKey.js'

function roundPoint(local) {
  if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.y)) return null
  return {
    x: Math.round(local.x * 1000) / 1000,
    y: Math.round(local.y * 1000) / 1000,
  }
}

function svgLocalPoint(svg, clientX, clientY, width, height) {
  if (!svg) return null
  const ctm = svg.getScreenCTM?.()
  if (ctm && svg.createSVGPoint) {
    try {
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const local = pt.matrixTransform(ctm.inverse())
      if (Number.isFinite(local.x) && Number.isFinite(local.y)) return { x: local.x, y: local.y }
    } catch {
      // A singular screen matrix falls through to the viewBox ratio.
    }
  }
  const bounds = svg.getBoundingClientRect()
  if (!(bounds.width > 0) || !(bounds.height > 0)) return null
  const view = svg.viewBox?.baseVal
  const vx = view?.width > 0 ? view.x : 0
  const vy = view?.height > 0 ? view.y : 0
  const vw = view?.width > 0 ? view.width : width
  const vh = view?.height > 0 ? view.height : height
  return {
    x: vx + ((clientX - bounds.left) / bounds.width) * vw,
    y: vy + ((clientY - bounds.top) / bounds.height) * vh,
  }
}

function screenVectorToUser(svg, dx, dy) {
  if (!svg) return null
  const ctm = svg.getScreenCTM?.()
  if (ctm && svg.createSVGPoint) {
    try {
      const inv = ctm.inverse()
      const origin = svg.createSVGPoint()
      origin.x = 0
      origin.y = 0
      const tip = svg.createSVGPoint()
      tip.x = dx
      tip.y = dy
      const o = origin.matrixTransform(inv)
      const t = tip.matrixTransform(inv)
      const x = t.x - o.x
      const y = t.y - o.y
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }
    } catch {
      // Fall through to the viewBox ratio.
    }
  }
  const bounds = svg.getBoundingClientRect()
  const view = svg.viewBox?.baseVal
  if (!(bounds.width > 0) || !(bounds.height > 0) || !(view?.width > 0) || !(view?.height > 0)) return null
  return {
    x: (dx / bounds.width) * view.width,
    y: (dy / bounds.height) * view.height,
  }
}

function polygonPoints(poly) {
  if (!poly?.length) return ''
  return poly.map((p) => `${Number(p.x).toFixed(3)},${Number(p.y).toFixed(3)}`).join(' ')
}

function segmentPolygon(segment, width) {
  const x1 = Number(segment?.p1?.x)
  const y1 = Number(segment?.p1?.y)
  const x2 = Number(segment?.p2?.x)
  const y2 = Number(segment?.p2?.y)
  return orientedBridgeRect(x1, y1, x2, y2, width)
}

export function StencilPreview({ active = true }) {
  const { settings } = useSettings()
  const { commitManualBridges } = useVectorEditor()
  const { stencilSheet, isGenerating } = useModel()
  const hostRef = useRef(null)
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const { spaceRef, spaceDown } = useSpacePanKey(active)
  const [view, setView] = useState(null)
  const [fitSpan, setFitSpan] = useState(0)
  const [draft, setDraft] = useState(null)
  const [panning, setPanning] = useState(false)

  const sheet = stencilSheet
  const boardW = sheet?.boardWidth
  const boardH = sheet?.boardHeight
  const manual = isManualBridgePlacement(settings)

  const fitToSheet = useCallback(() => {
    const el = hostRef.current
    if (!el || !(boardW > 0) || !(boardH > 0)) return
    const rect = el.getBoundingClientRect()
    const next = fittedSheetView(boardW, boardH, rect.width, rect.height)
    if (!next) return
    setFitSpan(next.w)
    setView(next)
  }, [boardW, boardH])

  useEffect(() => {
    const el = hostRef.current
    if (!el || !(boardW > 0) || !(boardH > 0)) return
    fitToSheet()
    let lastW = el.getBoundingClientRect().width
    let lastH = el.getBoundingClientRect().height
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      if (!(rect.width > 8) || !(rect.height > 8)) return
      if (Math.abs(rect.width - lastW) < 0.5 && Math.abs(rect.height - lastH) < 0.5) return
      const scale = lastW > 0 ? rect.width / lastW : 1
      if (!Number.isFinite(scale) || !(scale > 0)) return
      lastW = rect.width
      lastH = rect.height
      setFitSpan((span) => span * scale)
      setView((current) => {
        if (!current) return fittedSheetView(boardW, boardH, rect.width, rect.height)
        const nextW = current.w * scale
        const nextH = nextW * (rect.height / rect.width)
        if (!(nextW > 0) || !(nextH > 0) || !Number.isFinite(nextH)) return current
        const cx = current.x + current.w / 2
        const cy = current.y + current.h / 2
        return clampView(
          { x: cx - nextW / 2, y: cy - nextH / 2, w: nextW, h: nextH },
          Math.max(boardW, boardH),
        )
      })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [boardW, boardH, fitToSheet])

  useEffect(() => {
    const el = hostRef.current
    if (!el || !(boardW > 0) || !(boardH > 0)) return

    const onWheel = (event) => {
      const svg = svgRef.current
      if (!svg || event.deltaY === 0) return
      event.preventDefault()
      const local = svgLocalPoint(svg, event.clientX, event.clientY, boardW, boardH)
      if (!local) return
      const limits = sheetZoomLimits(boardW, boardH)
      setView((current) =>
        clampView(
          zoomViewBoxAt(current, local.x, local.y, event.deltaY < 0, limits.minW, limits.maxW),
          limits.span,
        ),
      )
    }

    const onMouseDown = (event) => {
      if (event.button === 1) event.preventDefault()
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('mousedown', onMouseDown)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('mousedown', onMouseDown)
    }
  }, [boardW, boardH])

  if (!sheet || !(boardW > 0) || !(boardH > 0)) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center px-8 text-center text-[13px] text-[var(--text-secondary)]">
        Upload artwork to preview the stencil sheet.
      </div>
    )
  }

  const unit = settings.unit || 'mm'
  const w = boardW
  const h = boardH
  const shown = view && view.w > 0 && view.h > 0 ? view : { x: 0, y: 0, w, h }
  const d = buildStencilPreviewD(sheet)
  const gapLabel =
    sheet.columns > 1 || sheet.rows > 1
      ? ` · gap ${formatDim(sheet.gapX, unit)} × ${formatDim(sheet.gapY, unit)}`
      : ''
  const segments = Array.isArray(settings.manualBridges) ? settings.manualBridges : []
  const bridgeWidth = Number(settings.bridgeWidth) > 0 ? Number(settings.bridgeWidth) : 1.5
  const bridgePolys = manual
    ? segments.map((segment) => segmentPolygon(segment, bridgeWidth)).filter(Boolean)
    : []
  const draftPoly = manual && draft ? segmentPolygon(draft, bridgeWidth) : null
  const zoomPct = view && fitSpan > 0 ? Math.round((fitSpan / view.w) * 100) : null
  const cursor = panning ? 'grabbing' : spaceDown ? 'grab' : manual ? 'crosshair' : 'default'

  const commitBridge = (p1, p2) => {
    if (!p1 || !p2) return
    if (!sheetPointInReach(p1.x, p1.y, w, h) || !sheetPointInReach(p2.x, p2.y, w, h)) return
    if (!(Math.hypot(p2.x - p1.x, p2.y - p1.y) >= MIN_MANUAL_BRIDGE_LENGTH)) return
    commitManualBridges((prev) => [
      ...prev,
      { p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y } },
    ])
  }

  const endGesture = (event, commit) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setPanning(false)
    if (drag.kind !== 'bridge') return
    const end = roundPoint(svgLocalPoint(svgRef.current, event.clientX, event.clientY, w, h))
    const draggedPx = Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy)
    setDraft(null)
    if (commit && manual && draggedPx >= 4) commitBridge(drag.p1, end)
  }

  const onPointerDown = (event) => {
    const svg = svgRef.current
    if (!svg) return
    if (isPanGesture(event, spaceRef.current)) {
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Tracking continues while the pointer stays over the sheet.
      }
      dragRef.current = { kind: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      setPanning(true)
      return
    }
    if (!manual || event.button !== 0) return
    const origin = roundPoint(svgLocalPoint(svg, event.clientX, event.clientY, w, h))
    if (!origin) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Tracking continues while the pointer stays over the sheet.
    }
    dragRef.current = {
      kind: 'bridge',
      pointerId: event.pointerId,
      p1: origin,
      sx: event.clientX,
      sy: event.clientY,
    }
    setDraft({ p1: origin, p2: origin })
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.kind === 'pan') {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      drag.x = event.clientX
      drag.y = event.clientY
      const delta = screenVectorToUser(svgRef.current, dx, dy)
      if (!delta) return
      const limits = sheetZoomLimits(w, h)
      setView((current) => clampView(panViewBy(current, delta.x, delta.y), limits.span))
      return
    }
    const end = roundPoint(svgLocalPoint(svgRef.current, event.clientX, event.clientY, w, h))
    if (!end) return
    setDraft({ p1: drag.p1, p2: end })
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden" style={{ background: 'var(--canvas-vignette)' }}>
      <div
        ref={hostRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endGesture(event, true)}
        onPointerCancel={(event) => endGesture(event, false)}
        onDoubleClick={(event) => {
          if (event.button !== 0) return
          fitToSheet()
        }}
      >
        <svg
          ref={svgRef}
          viewBox={viewBoxAttr(shown)}
          preserveAspectRatio="xMidYMid meet"
          className="pointer-events-none absolute inset-0 h-full w-full"
          role="img"
          aria-label={manual ? 'Stencil sheet. Drag to draw a bridge.' : 'Stencil sheet preview'}
        >
          <defs>
            <pattern id="stencil-sheet-checker" width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill="var(--bg-canvas)" />
              <rect width="3" height="3" fill="var(--border)" />
              <rect x="3" y="3" width="3" height="3" fill="var(--border)" />
            </pattern>
          </defs>
          <rect x={shown.x} y={shown.y} width={shown.w} height={shown.h} fill="transparent" />
          <rect x="0" y="0" width={w} height={h} fill="url(#stencil-sheet-checker)" />
          <path d={d} fill="#8fb4cc" fillRule="evenodd" />
          {bridgePolys.map((poly, index) => (
            <polygon
              key={`bridge-${index}`}
              points={polygonPoints(poly)}
              fill="#2563eb"
              fillOpacity="0.92"
              stroke="#ffffff"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {draft && draftPoly && (
            <polygon
              points={polygonPoints(draftPoly)}
              fill="#2563eb"
              fillOpacity="0.55"
              stroke="#ffffff"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {draft && (
            <line
              x1={draft.p1.x}
              y1={draft.p1.y}
              x2={draft.p2.x}
              y2={draft.p2.y}
              stroke="#1d4ed8"
              strokeWidth="1.25"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <div className="pointer-events-none absolute bottom-3 left-4 right-4 flex flex-wrap items-end justify-between gap-2 text-[12px] text-[var(--text-secondary)]">
          <div className="rounded-md bg-[var(--bg-header)]/90 px-2.5 py-1.5 shadow-sm">
            <span className="mr-3 inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#8fb4cc]" />
              Plastic
            </span>
            <span className="mr-3 inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-[var(--border)]" style={{ background: 'var(--bg-canvas)' }} />
              Cutout
            </span>
            {manual && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#2563eb]" />
                Bridge
              </span>
            )}
          </div>
          <div className="rounded-md bg-[var(--bg-header)]/90 px-2.5 py-1.5 text-right shadow-sm">
            <div>
              {formatDim(w, unit)} × {formatDim(h, unit)} · {sheet.rows}×{sheet.columns}
              {gapLabel}
              {zoomPct != null ? ` · ${zoomPct}%` : ''}
              {isGenerating ? ' · updating' : ''}
            </div>
            <div className="mt-0.5 text-[11px]">
              Scroll to zoom · middle-drag or space-drag to pan · double-click to fit
              {manual ? ' · drag to draw a bridge' : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
