import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVectorEditor } from '../../../context/useVectorEditor.js'
import { useSettings } from '../../../context/useSettings.js'
import { measureFit } from '../../../lib/pathMetrics.js'
import { clientToSvgUser, svgUnitsPerScreenPixel } from '../../../lib/vectorCoordinates.js'
import {
  DASH_CUT_MM,
  DASH_GAP_MM,
  entityGroupIds,
  isFilledEntity,
  translateEntityList,
  withEntityVertex,
} from '../../../lib/vectorEntities.js'
import { eraseEntities } from '../../../lib/vectorErase.js'
import { buildDragPrimitive } from '../../../lib/vectorPrimitives.js'
import { smoothFreehand } from '../../../lib/vectorSmooth.js'

const SAMPLE_SPACING = 1.25
const MIN_COMMIT_LENGTH = 3
const PRIMITIVE_PREVIEW_MIN = 0.25
const PRIMITIVE_COMMIT_MIN = 1

function pointsAttr(points) {
  let text = ''
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (i) text += ' '
    text += `${p.x.toFixed(2)},${p.y.toFixed(2)}`
  }
  return text
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function polylineLength(points) {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return length
}

/** One box around every selected ring, shifted while a move preview is active. */
function selectionFrame(entities, ids, resolve, moveIds, moveOffset) {
  const wanted = new Set(ids)
  if (!wanted.size) return null
  const dx = moveOffset?.x || 0
  const dy = moveOffset?.y || 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const raw of entities) {
    if (!wanted.has(raw.id)) continue
    const entity = resolve(raw)
    const shiftX = moveIds?.has(entity.id) ? dx : 0
    const shiftY = moveIds?.has(entity.id) ? dy : 0
    const rings = [entity.points, ...(entity.holes || [])]
    for (const ring of rings) {
      if (!ring) continue
      for (const point of ring) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
        const x = point.x + shiftX
        const y = point.y + shiftY
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, width: Math.max(maxX - minX, 0), height: Math.max(maxY - minY, 0) }
}

function pointInPolygon(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** An interior hit ranks below every outline hit, so a large fill never hides what is drawn on it. */
const INTERIOR_RANK = 1e9

/**
 * Picks the entity under the cursor. An outline within tolerance wins by
 * distance. Failing that, the cursor inside a filled area (a filled shape,
 * an erased region, the traced silhouette) picks it. Entities are visited
 * top-most first and ties keep the first visited, so a shape drawn over the
 * silhouette is chosen over the silhouette.
 */
function hitEntity(entities, point, baseTolerance, pixelsPerMm) {
  let best = null
  let bestRank = Infinity
  for (let e = entities.length - 1; e >= 0; e--) {
    const entity = entities[e]
    const pts = entity.points
    if (!pts || pts.length < 2) continue
    const filled = isFilledEntity(entity)
    const closed = Boolean(entity.closed) || filled
    const rings = [pts, ...(entity.holes || [])]
    const tol = filled
      ? baseTolerance
      : Math.max(baseTolerance, strokeUnits(entity.strokeWidth, pixelsPerMm) * 0.55)
    let edge = Infinity
    for (const ring of rings) {
      if (!ring || ring.length < 2) continue
      const limit = ring.length - (closed ? 0 : 1)
      for (let i = 0; i < limit; i++) {
        const d = distToSegment(point, ring[i], ring[(i + 1) % ring.length])
        if (d <= tol && d < edge) edge = d
      }
    }
    let rank = edge
    if (
      rank === Infinity &&
      filled &&
      pts.length >= 3 &&
      pointInPolygon(point, pts) &&
      !(entity.holes || []).some((hole) => hole.length >= 3 && pointInPolygon(point, hole))
    ) {
      rank = INTERIOR_RANK
    }
    if (rank < bestRank) {
      bestRank = rank
      best = entity
    }
  }
  return best
}

function hitVertex(entities, selectedIds, point, tolerance) {
  const selected = new Set(selectedIds)
  let best = null
  let bestDist = tolerance
  const consider = (id, ring, holeIndex) => {
    if (!ring) return
    for (let index = 0; index < ring.length; index++) {
      const p = ring[index]
      const d = Math.hypot(point.x - p.x, point.y - p.y)
      if (d <= bestDist) {
        bestDist = d
        best = { id, index, holeIndex }
      }
    }
  }
  for (const entity of entities) {
    if (!selected.has(entity.id)) continue
    consider(entity.id, entity.points, -1)
    const holes = entity.holes || []
    for (let holeIndex = 0; holeIndex < holes.length; holeIndex++) {
      consider(entity.id, holes[holeIndex], holeIndex)
    }
  }
  return best
}

function strokeUnits(strokeMm, pixelsPerMm) {
  const px = strokeMm * pixelsPerMm
  return px > 0.4 ? px : 0.4
}

function dashArrayAttr(pixelsPerMm) {
  const cut = DASH_CUT_MM * pixelsPerMm
  const gap = DASH_GAP_MM * pixelsPerMm
  if (!(cut > 0) || !(gap > 0)) return undefined
  return `${cut.toFixed(2)} ${gap.toFixed(2)}`
}

function ringsPath(rings) {
  let d = ''
  for (const ring of rings) {
    if (!ring || ring.length < 2) continue
    d += `M ${ring[0].x.toFixed(2)} ${ring[0].y.toFixed(2)}`
    for (let i = 1; i < ring.length; i++) {
      d += ` L ${ring[i].x.toFixed(2)} ${ring[i].y.toFixed(2)}`
    }
    if (ring.length >= 3) d += ' Z'
  }
  return d
}

function capturePointer(target, pointerId) {
  try {
    target.setPointerCapture(pointerId)
  } catch {
    // Moves still arrive while the pointer stays over the svg.
  }
}

function strokePaint(entity, isSelected, pixelsPerMm, dash) {
  if (isFilledEntity(entity)) {
    // A solid area. The thin outline is a screen-space hairline, not a
    // stroke band, because the cutter adds nothing outside a filled edge.
    // The traced silhouette is tinted lighter so the image stays readable.
    const base = Boolean(entity.base)
    let fill = isSelected ? 'rgba(167,139,250,0.7)' : 'rgba(167,139,250,0.55)'
    if (base) fill = isSelected ? 'rgba(167,139,250,0.34)' : 'rgba(167,139,250,0.22)'
    return {
      fill,
      stroke: isSelected ? '#7c3aed' : '#8b5cf6',
      strokeWidth: base ? 1.5 : 1.25,
      strokeLinejoin: 'round',
      vectorEffect: 'non-scaling-stroke',
    }
  }
  return {
    fill: 'none',
    stroke: isSelected ? '#a78bfa' : '#e07a86',
    strokeWidth: strokeUnits(entity.strokeWidth, pixelsPerMm),
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeDasharray: entity.lineStyle === 'dashed' ? dash : undefined,
  }
}

/**
 * One entity. Memoised on the entity object, which is replaced only when it
 * changes, so a drag frame re-renders only the shapes that frame touched.
 * `offset` previews a move as an SVG transform; the point string is not rebuilt.
 */
const EntityShape = memo(function EntityShape({ entity, selected, pixelsPerMm, dash, offset }) {
  const filled = isFilledEntity(entity)
  const holed = filled && entity.holes?.length > 0
  const geometry = useMemo(
    () => (holed ? ringsPath([entity.points, ...entity.holes]) : pointsAttr(entity.points)),
    [holed, entity.points, entity.holes],
  )
  const paint = strokePaint(entity, selected, pixelsPerMm, dash)
  const transform = offset ? `translate(${offset.x} ${offset.y})` : undefined
  if (holed) return <path d={geometry} fillRule="nonzero" transform={transform} {...paint} />
  if (entity.closed || filled) return <polygon points={geometry} transform={transform} {...paint} />
  return <polyline points={geometry} transform={transform} {...paint} />
})

const NodeHandles = memo(function NodeHandles({ entity, radius, onHandleDown }) {
  const rings = [entity.points, ...(entity.holes || [])]
  return (
    <>
      {rings.flatMap((ring, ringIndex) => {
        const holeIndex = ringIndex - 1
        return (ring || []).map((p, index) => (
          <circle
            key={`${holeIndex}:${index}`}
            cx={p.x}
            cy={p.y}
            r={radius}
            fill="#ffffff"
            stroke="#7c3aed"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: 'grab' }}
            onPointerDown={(event) => onHandleDown(event, entity.id, index, holeIndex)}
          />
        ))
      })}
    </>
  )
})

export const VectorCanvas = memo(function VectorCanvas({ frame, viewport = null, spaceRef, spaceDown = false }) {
  const svgRef = useRef(null)
  const gestureRef = useRef(null)
  const { rawPaths, settings } = useSettings()
  const {
    entities,
    activeTool,
    selectedEntityIds,
    strokeWidthMm,
    lineStyle,
    eraserSizeMm,
    canvasTransform,
    selectOnly,
    toggleSelected,
    clearSelection,
    commitEntity,
    commitGestureEntities,
  } = useVectorEditor()
  const [draft, setDraft] = useState(null)
  // What an unfinished move, node drag or erase stroke would commit. It stays
  // local so a drag re-renders only this svg; the editor history and the 3D
  // build receive the result once, on pointerup.
  const [preview, setPreview] = useState(null)
  const [brush, setBrush] = useState(null)
  const [handleRadius, setHandleRadius] = useState(4)
  const entitiesRef = useRef(entities)
  useLayoutEffect(() => {
    entitiesRef.current = entities
  }, [entities])

  const fitScale = useMemo(() => {
    if (!rawPaths?.length) return null
    return measureFit(rawPaths, settings.width, settings.height, settings.aspectLocked)?.sx ?? null
  }, [rawPaths, settings.width, settings.height, settings.aspectLocked])
  const pixelsPerMm = fitScale > 0 ? 1 / fitScale : frame.width / Math.max(settings.width, 0.001)

  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const measure = () => {
      const units = svgUnitsPerScreenPixel(svg)
      const next = Math.max(units * 5.5, 0.75)
      setHandleRadius((prev) => (Math.abs(prev - next) < 0.05 ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [canvasTransform, frame.width, frame.height])

  const selected = useMemo(() => new Set(selectedEntityIds), [selectedEntityIds])
  const drawing =
    activeTool === 'draw' || activeTool === 'line' || activeTool === 'rect' || activeTool === 'circle'
  let cursor = 'default'
  if (spaceDown) cursor = 'grab'
  else if (drawing || activeTool === 'eraser') cursor = 'crosshair'
  const dash = dashArrayAttr(pixelsPerMm)
  const view =
    viewport && viewport.width > 0 && viewport.height > 0
      ? viewport
      : { x: 0, y: 0, width: frame.width, height: frame.height }
  // A two-point preview has no area, so it keeps drawing as a stroke.
  const draftFilled = lineStyle === 'filled' && (draft?.points?.length ?? 0) >= 3
  const eraserRadius = eraserSizeMm * pixelsPerMm

  const shown = preview?.mode === 'erase' ? preview.entities : entities
  const moveIds = preview?.mode === 'move' ? preview.ids : null
  const moveOffset = preview?.mode === 'move' ? preview.offset : undefined
  const nodeEntity = preview?.mode === 'node' ? preview.entity : null
  const resolve = (entity) => (nodeEntity && nodeEntity.id === entity.id ? nodeEntity : entity)
  const selectionBox = selectionFrame(shown, selectedEntityIds, resolve, moveIds, moveOffset)

  const beginNodeDrag = useCallback(
    (event, entityId, index, holeIndex = -1) => {
      if (event.button !== 0) return
      if (spaceRef?.current) return
      const base = entitiesRef.current
      const entity = base.find((item) => item.id === entityId)
      if (!entity) return
      event.stopPropagation()
      event.preventDefault()
      const svg = svgRef.current
      if (svg) capturePointer(svg, event.pointerId)
      gestureRef.current = {
        mode: 'node',
        pointerId: event.pointerId,
        base,
        entity,
        moved: entity,
        index,
        holeIndex,
      }
    },
    [spaceRef],
  )

  const stampErase = (gesture, from, to) => {
    const radius = eraserSizeMm * pixelsPerMm
    if (!(radius > 0)) return
    const spacing = Math.max(radius * 0.35, 0.5)
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    const steps = Math.max(1, Math.ceil(dist / spacing))
    let working = gesture.working
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      working = eraseEntities(
        working,
        { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
        radius,
        pixelsPerMm,
      )
    }
    if (working === gesture.working) return
    gesture.working = working
    setPreview({ mode: 'erase', entities: working })
  }

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    if (spaceRef?.current) return
    const svg = svgRef.current
    const logical = clientToSvgUser(svg, event.clientX, event.clientY)
    if (!logical) return

    if (activeTool === 'node') {
      const vertex = hitVertex(
        entitiesRef.current,
        selectedEntityIds,
        logical,
        Math.max(handleRadius * 1.6, svgUnitsPerScreenPixel(svg) * 10),
      )
      if (vertex) {
        beginNodeDrag(event, vertex.id, vertex.index, vertex.holeIndex)
        return
      }
      const hit = hitEntity(entitiesRef.current, logical, 8 * svgUnitsPerScreenPixel(svg), pixelsPerMm)
      if (!hit) {
        if (!event.shiftKey) clearSelection()
        return
      }
      event.stopPropagation()
      if (event.shiftKey) {
        toggleSelected(hit.id)
        return
      }
      selectOnly(hit.id)
      return
    }

    if (activeTool === 'eraser') {
      event.stopPropagation()
      event.preventDefault()
      capturePointer(event.currentTarget, event.pointerId)
      const base = entitiesRef.current
      const gesture = { mode: 'erase', pointerId: event.pointerId, last: logical, base, working: base }
      gestureRef.current = gesture
      setBrush(logical)
      stampErase(gesture, logical, logical)
      return
    }

    if (activeTool === 'line' || activeTool === 'rect' || activeTool === 'circle') {
      event.stopPropagation()
      event.preventDefault()
      capturePointer(event.currentTarget, event.pointerId)
      gestureRef.current = {
        mode: 'primitive',
        kind: activeTool,
        pointerId: event.pointerId,
        origin: logical,
        current: logical,
      }
      setDraft(null)
      return
    }

    if (activeTool === 'draw') {
      event.stopPropagation()
      event.preventDefault()
      capturePointer(event.currentTarget, event.pointerId)
      gestureRef.current = {
        mode: 'draw',
        pointerId: event.pointerId,
        raw: [logical],
      }
      setDraft({ points: [logical], closed: false })
      return
    }

    if (activeTool !== 'select') return
    const hit = hitEntity(
      entitiesRef.current,
      logical,
      8 * svgUnitsPerScreenPixel(svg),
      pixelsPerMm,
    )
    if (!hit) {
      if (!event.shiftKey) clearSelection()
      return
    }
    event.stopPropagation()
    event.preventDefault()
    if (event.shiftKey) {
      toggleSelected(hit.id)
      return
    }
    capturePointer(event.currentTarget, event.pointerId)
    const alreadySelected = selected.has(hit.id)
    if (!alreadySelected) selectOnly(hit.id)
    // No clamp: the delta is the pointer's user-space travel, including
    // coordinates outside the trace. A group, or an existing multi-selection,
    // moves as one body.
    const moveIds = alreadySelected
      ? selectedEntityIds
      : entityGroupIds(entitiesRef.current, hit.id)
    gestureRef.current = {
      mode: 'move',
      pointerId: event.pointerId,
      origin: logical,
      ids: new Set(moveIds),
      base: entitiesRef.current,
      dx: 0,
      dy: 0,
    }
  }

  const onPointerMove = (event) => {
    const logical = clientToSvgUser(svgRef.current, event.clientX, event.clientY)
    if (activeTool === 'eraser') {
      if (logical) setBrush(logical)
    } else if (brush) {
      setBrush(null)
    }

    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !logical) return

    if (gesture.mode === 'draw') {
      const raw = gesture.raw
      const last = raw[raw.length - 1]
      if (Math.hypot(logical.x - last.x, logical.y - last.y) < 0.8) return
      raw.push(logical)
      setDraft({ points: smoothFreehand(raw, SAMPLE_SPACING), closed: false })
      return
    }

    if (gesture.mode === 'primitive') {
      gesture.current = logical
      setDraft(buildDragPrimitive(gesture.kind, gesture.origin, logical, PRIMITIVE_PREVIEW_MIN))
      return
    }

    if (gesture.mode === 'erase') {
      stampErase(gesture, gesture.last, logical)
      gesture.last = logical
      return
    }

    if (gesture.mode === 'node') {
      const moved = withEntityVertex(gesture.entity, gesture.index, logical, gesture.holeIndex)
      if (moved === gesture.moved) return
      gesture.moved = moved
      setPreview({ mode: 'node', entity: moved })
      return
    }

    if (gesture.mode === 'move') {
      const dx = logical.x - gesture.origin.x
      const dy = logical.y - gesture.origin.y
      if (dx === gesture.dx && dy === gesture.dy) return
      gesture.dx = dx
      gesture.dy = dy
      setPreview({ mode: 'move', ids: gesture.ids, offset: { x: dx, y: dy } })
    }
  }

  const endGesture = (event) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (gesture.mode === 'move') {
      setPreview(null)
      commitGestureEntities(
        translateEntityList(gesture.base, gesture.ids, gesture.dx, gesture.dy),
        gesture.base,
      )
      return
    }
    if (gesture.mode === 'node') {
      setPreview(null)
      if (gesture.moved === gesture.entity) return
      commitGestureEntities(
        gesture.base.map((entity) => (entity === gesture.entity ? gesture.moved : entity)),
        gesture.base,
      )
      return
    }
    if (gesture.mode === 'erase') {
      setPreview(null)
      commitGestureEntities(gesture.working, gesture.base)
      return
    }
    if (gesture.mode === 'draw') {
      const smoothed = smoothFreehand(gesture.raw, SAMPLE_SPACING)
      setDraft(null)
      if (polylineLength(smoothed) >= MIN_COMMIT_LENGTH) {
        commitEntity({
          type: 'path',
          points: smoothed,
          closed: false,
          strokeWidth: strokeWidthMm,
          lineStyle,
        })
      }
      return
    }
    if (gesture.mode === 'primitive') {
      const built = buildDragPrimitive(gesture.kind, gesture.origin, gesture.current, PRIMITIVE_COMMIT_MIN)
      setDraft(null)
      if (!built) return
      commitEntity({
        type: gesture.kind,
        points: built.points,
        closed: built.closed,
        strokeWidth: strokeWidthMm,
        lineStyle,
      })
    }
  }

  return (
    <svg
      ref={svgRef}
      className="h-full w-full touch-none"
      viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
      preserveAspectRatio="none"
      overflow="visible"
      style={{ cursor, overflow: 'visible' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={() => setBrush(null)}
    >
      {shown.map((entity) => {
        if (!entity.points || entity.points.length < 2) return null
        return (
          <EntityShape
            key={entity.id}
            entity={resolve(entity)}
            selected={selected.has(entity.id)}
            pixelsPerMm={pixelsPerMm}
            dash={dash}
            offset={moveIds?.has(entity.id) ? moveOffset : undefined}
          />
        )
      })}
      {draft && draft.points.length > 1 && (
        draftFilled ? (
          <polygon
            points={pointsAttr(draft.points)}
            fill="rgba(167,139,250,0.55)"
            stroke="#8b5cf6"
            strokeWidth={1.25}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            opacity="0.9"
          />
        ) : draft.closed ? (
          <polygon
            points={pointsAttr(draft.points)}
            fill="none"
            stroke="#e07a86"
            strokeWidth={strokeUnits(strokeWidthMm, pixelsPerMm)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={lineStyle === 'dashed' ? dash : undefined}
            opacity="0.9"
          />
        ) : (
          <polyline
            points={pointsAttr(draft.points)}
            fill="none"
            stroke="#e07a86"
            strokeWidth={strokeUnits(strokeWidthMm, pixelsPerMm)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={lineStyle === 'dashed' ? dash : undefined}
            opacity="0.9"
          />
        )
      )}
      {selectionBox && (
        <rect
          x={selectionBox.x}
          y={selectionBox.y}
          width={selectionBox.width}
          height={selectionBox.height}
          fill="rgba(124,58,237,0.08)"
          stroke="#7c3aed"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
      {activeTool === 'node' &&
        shown.map((entity) => {
          if (!selected.has(entity.id) || !entity.points) return null
          return (
            <NodeHandles
              key={entity.id}
              entity={resolve(entity)}
              radius={handleRadius}
              onHandleDown={beginNodeDrag}
            />
          )
        })}
      {activeTool === 'eraser' && brush && eraserRadius > 0 && (
        <circle
          cx={brush.x}
          cy={brush.y}
          r={eraserRadius}
          fill="rgba(167,139,250,0.15)"
          stroke="#a78bfa"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
    </svg>
  )
})
