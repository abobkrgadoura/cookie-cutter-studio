import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clampScreenZoom, zoomScreenAt } from '../../lib/cadViewport.js'
import { traceRasterSize } from '../../lib/vectorizer.js'
import { isPanGesture, useSpacePanKey } from './useSpacePanKey.js'

/**
 * Editor units per displayed pixel, so SVG user (0, 0) stays on the image's
 * top-left while the viewBox covers the whole pane. Shapes can sit anywhere
 * on the grid, including coordinates outside the trace.
 */
function editorViewport(frame, box, host) {
  if (!frame || !box || !(box.width > 0) || !(box.height > 0)) return null
  if (!host || !(host.w > 0) || !(host.h > 0)) return null
  const sx = frame.width / box.width
  const sy = frame.height / box.height
  if (![sx, sy].every((value) => Number.isFinite(value) && value > 0)) return null
  return {
    x: -box.left * sx,
    y: -box.top * sy,
    width: host.w * sx,
    height: host.h * sy,
  }
}

/**
 * Raster / SVG preview on an infinite 2D canvas.
 * Scroll zooms at the cursor. Middle-drag, or space + left-drag, pans.
 * `overlay` covers the whole pane in the trace-raster frame and pans with
 * the image. `canvasTransform` is owned by the vector editor.
 */
export function TraceCanvas({
  src,
  resetKey = '',
  filter,
  active = true,
  punched = false,
  canvasTransform,
  onCanvasTransform,
  toolCursor = 'default',
  overlay = null,
}) {
  const hostRef = useRef(null)
  const imgRef = useRef(null)
  const dragRef = useRef(null)
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const { spaceRef, spaceDown } = useSpacePanKey(active)
  const zoom = canvasTransform?.zoom ?? 1
  const pan = canvasTransform?.pan ?? { x: 0, y: 0 }
  const [panning, setPanning] = useState(false)
  const [frame, setFrame] = useState(null)
  const [box, setBox] = useState(null)
  const [hostSize, setHostSize] = useState(null)
  const [trackedKey, setTrackedKey] = useState(resetKey)

  if (trackedKey !== resetKey) {
    setTrackedKey(resetKey)
    setFrame(null)
    setBox(null)
  }

  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measureHost = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      setHostSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measureHost()
    const observer = new ResizeObserver(measureHost)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const viewport = useMemo(() => editorViewport(frame, box, hostSize), [frame, box, hostSize])

  useLayoutEffect(() => {
    zoomRef.current = zoom
    panRef.current = pan
  }, [zoom, pan])

  const applyView = useCallback(
    (nextZoom, nextPan) => {
      onCanvasTransform?.({
        zoom: clampScreenZoom(nextZoom),
        pan: nextPan,
      })
    },
    [onCanvasTransform],
  )

  const measure = useCallback(() => {
    const img = imgRef.current
    if (!img || !(img.offsetWidth > 1) || !(img.offsetHeight > 1)) {
      setBox(null)
      return
    }
    setBox({
      left: img.offsetLeft,
      top: img.offsetTop,
      width: img.offsetWidth,
      height: img.offsetHeight,
    })
  }, [])

  useLayoutEffect(() => {
    const img = imgRef.current
    if (!img) return
    measure()
    const observer = new ResizeObserver(() => measure())
    observer.observe(img)
    return () => observer.disconnect()
  }, [src, frame, measure])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const onWheel = (event) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const ox = event.clientX - rect.left - rect.width / 2
      const oy = event.clientY - rect.top - rect.height / 2
      const applied = zoomScreenAt(panRef.current, zoomRef.current, ox, oy, event.deltaY < 0)
      applyView(applied.zoom, applied.pan)
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
  }, [applyView])

  const endPan = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setPanning(false)
  }

  const onPointerDown = (event) => {
    if (!isPanGesture(event, spaceRef.current)) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // The move handler still tracks the pointer while it stays over the canvas.
    }
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    setPanning(true)
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    drag.x = event.clientX
    drag.y = event.clientY
    applyView(zoomRef.current, { x: panRef.current.x + dx, y: panRef.current.y + dy })
  }

  const onImageLoad = (event) => {
    const img = event.currentTarget
    const sized = traceRasterSize(img.naturalWidth || img.width, img.naturalHeight || img.height)
    setFrame(sized)
    measure()
  }

  const cursor = panning ? 'grabbing' : spaceDown ? 'grab' : toolCursor
  const shownZoom = Math.round(clampScreenZoom(zoom) * 100)
  const overlayNode =
    overlay && frame && box && viewport
      ? overlay({ frame, viewport, spaceRef, spaceDown })
      : null

  return (
    <div
      ref={hostRef}
      className="relative min-h-0 min-w-0 flex-1 touch-none select-none overflow-hidden"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={() => {
        applyView(1, { x: 0, y: 0 })
      }}
    >
      <div
        className={`pointer-events-none absolute inset-0 ${punched ? 'opacity-40' : 'opacity-20'}`}
        style={{
          backgroundImage: 'radial-gradient(var(--text-muted) 1px, transparent 0)',
          backgroundSize: '20px 20px',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
        }}
      >
        {src && (
          <img
            ref={imgRef}
            src={src}
            alt="Trace Source"
            draggable={false}
            onLoad={onImageLoad}
            className={`max-h-[80%] max-w-[80%] object-contain ${punched ? '' : 'shadow-lg'}`}
            style={{ filter }}
          />
        )}
        {overlayNode && (
          <div className="pointer-events-auto absolute inset-0">
            {overlayNode}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-3 left-4 text-[12px] text-[var(--text-secondary)]">
        <div className="rounded-md bg-[var(--bg-header)]/90 px-2.5 py-1.5 shadow-sm">
          Scroll to zoom · middle-drag or space-drag to pan · double-click to fit · {shownZoom}%
        </div>
      </div>
    </div>
  )
}
