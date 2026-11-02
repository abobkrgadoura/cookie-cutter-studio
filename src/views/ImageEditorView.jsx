import { useCallback, useEffect, useRef, useState } from 'react'
import { Toggle } from '../components/ui/Toggle.jsx'
import { DrawingToolbar } from '../components/viewer/vector/DrawingToolbar.jsx'
import { PropertiesPanel, VectorHistoryButtons } from '../components/viewer/vector/PropertiesPanel.jsx'
import { VectorCanvas } from '../components/viewer/vector/VectorCanvas.jsx'
import { StencilPreview } from '../components/viewer/StencilPreview.jsx'
import { TraceCanvas } from '../components/viewer/TraceCanvas.jsx'
import { useSettings } from '../context/useSettings.js'
import { useVectorEditor } from '../context/useVectorEditor.js'
import { clampTraceThreshold } from '../lib/constants.js'
import { removeWhiteBackground } from '../lib/removeWhiteBackground.js'
import { vectorToolCursor } from '../lib/vectorEntities.js'

const HISTORY_LIMIT = 3

function traceSnapshot(threshold, invert) {
  return {
    threshold: clampTraceThreshold(threshold),
    invert: Boolean(invert),
  }
}

export function ImageEditorView({ active = true, showStencil = false }) {
  const { image, settings, patch, isTracing } = useSettings()
  const {
    activeTool,
    setActiveTool,
    canvasTransform,
    setCanvasTransform,
    selectedEntityIds,
    deleteSelected,
    undo: undoEntities,
    redo: redoEntities,
  } = useVectorEditor()
  const initial = traceSnapshot(settings.imageThreshold, settings.imageInvert)

  // Max 3 snapshots: the live one plus two steps back. A slider drag commits
  // once, on release, so those two steps are whole adjustments.
  const [history, setHistory] = useState(() => [initial])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  const [liveThreshold, setLiveThreshold] = useState(null)
  const removeBackground = settings.removeBackground !== false
  const setRemoveBackground = useCallback(
    (value) => patch({ removeBackground: Boolean(value) }),
    [patch],
  )
  const [keyedUrl, setKeyedUrl] = useState(null)
  const [keying, setKeying] = useState(false)
  const [keyError, setKeyError] = useState(null)

  const historyRef = useRef(history)
  const indexRef = useRef(currentIndex)
  const liveThresholdRef = useRef(null)
  // Snapshot we just wrote via patch(). The settings echo must not collapse
  // the stack if it lands before this component's history state does.
  const pendingLocalRef = useRef(null)
  historyRef.current = history
  indexRef.current = currentIndex

  const imageKey = `${image?.url ?? ''}|${image?.name ?? ''}|${image?.isSvg ? 'svg' : 'raster'}`

  useEffect(() => {
    setKeyedUrl(null)
    setKeying(false)
    setKeyError(null)
  }, [imageKey])

  useEffect(() => {
    const sourceUrl = image?.url
    if (!removeBackground || !sourceUrl || image?.isSvg || !image?.source) {
      setKeyedUrl(null)
      setKeying(false)
      setKeyError(null)
      return
    }

    let cancelled = false
    setKeying(true)
    setKeyError(null)
    removeWhiteBackground(sourceUrl)
      .then((url) => {
        if (!cancelled) setKeyedUrl(url)
      })
      .catch((err) => {
        console.error('[image] remove background failed:', err)
        if (cancelled) return
        setKeyedUrl(null)
        setKeyError('Could not remove the white background.')
      })
      .finally(() => {
        if (!cancelled) setKeying(false)
      })

    return () => {
      cancelled = true
    }
  }, [removeBackground, image?.url, image?.isSvg, image?.source])

  const pushHistory = useCallback(
    (threshold, invert) => {
      const snapshot = traceSnapshot(threshold, invert)
      const prevHist = historyRef.current
      const idx = indexRef.current
      const current = prevHist[idx]
      if (current && current.threshold === snapshot.threshold && current.invert === snapshot.invert) {
        return
      }
      const next = prevHist.slice(0, idx + 1)
      next.push(snapshot)
      if (next.length > HISTORY_LIMIT) next.shift()
      historyRef.current = next
      indexRef.current = next.length - 1
      pendingLocalRef.current = snapshot
      setHistory(next)
      setCurrentIndex(next.length - 1)
      patch({ imageThreshold: snapshot.threshold, imageInvert: snapshot.invert })
    },
    [patch],
  )

  const undoTrace = useCallback(() => {
    if (indexRef.current <= 0) return
    const prev = historyRef.current[indexRef.current - 1]
    indexRef.current -= 1
    pendingLocalRef.current = prev
    setCurrentIndex(indexRef.current)
    patch({ imageThreshold: prev.threshold, imageInvert: prev.invert })
  }, [patch])

  const redoTrace = useCallback(() => {
    if (indexRef.current >= historyRef.current.length - 1) return
    const next = historyRef.current[indexRef.current + 1]
    indexRef.current += 1
    pendingLocalRef.current = next
    setCurrentIndex(indexRef.current)
    patch({ imageThreshold: next.threshold, imageInvert: next.invert })
  }, [patch])

  const undo = useCallback(() => {
    if (!undoEntities()) undoTrace()
  }, [undoEntities, undoTrace])

  const redo = useCallback(() => {
    if (!redoEntities()) redoTrace()
  }, [redoEntities, redoTrace])

  const commitThreshold = useCallback(() => {
    const threshold = liveThresholdRef.current
    if (threshold == null) return
    liveThresholdRef.current = null
    setLiveThreshold(null)
    const invert = historyRef.current[indexRef.current]?.invert ?? false
    pushHistory(threshold, invert)
  }, [pushHistory])

  // A new upload starts a fresh stack. Threshold edits on the same image
  // must not land here — that would wipe undo on every commit.
  useEffect(() => {
    const snapshot = traceSnapshot(settings.imageThreshold, settings.imageInvert)
    const stack = [snapshot]
    historyRef.current = stack
    indexRef.current = 0
    liveThresholdRef.current = null
    setHistory(stack)
    setCurrentIndex(0)
    setLiveThreshold(null)
    // settings are read from the render that changed the image, not from
    // later slider commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey])

  // Profile load / reset defaults change the trace knobs without going
  // through this stack. Adopt that value and drop the stale steps.
  useEffect(() => {
    if (liveThresholdRef.current != null) return
    const snapshot = traceSnapshot(settings.imageThreshold, settings.imageInvert)
    const pending = pendingLocalRef.current
    if (pending && pending.threshold === snapshot.threshold && pending.invert === snapshot.invert) {
      pendingLocalRef.current = null
      return
    }
    const current = historyRef.current[indexRef.current]
    if (current && current.threshold === snapshot.threshold && current.invert === snapshot.invert) {
      return
    }
    const stack = [snapshot]
    historyRef.current = stack
    indexRef.current = 0
    setHistory(stack)
    setCurrentIndex(0)
  }, [settings.imageThreshold, settings.imageInvert])

  useEffect(() => {
    if (!active || showStencil) return
    const onKey = (event) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (!selectedEntityIds.length) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'TEXTAREA' || target.isContentEditable) return
        if (tag === 'INPUT') return
      }
      event.preventDefault()
      deleteSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, showStencil, selectedEntityIds.length, deleteSelected])

  useEffect(() => {
    if (!active) return
    const onKey = (event) => {
      const meta = event.ctrlKey || event.metaKey
      if (!meta) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'TEXTAREA' || target.isContentEditable) return
        if (tag === 'INPUT' && target.type !== 'range' && target.type !== 'checkbox') return
      }
      if (event.key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if ((event.key === 'z' && event.shiftKey) || event.key === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, undo, redo])

  const current = history[currentIndex] ?? traceSnapshot(settings.imageThreshold, settings.imageInvert)
  const shownThreshold = liveThreshold ?? current.threshold
  const shownInvert = current.invert
  const rangePct = ((shownThreshold - 1) / (254 - 1)) * 100

  if (!image) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--text-muted)]">
        No image loaded
      </div>
    )
  }

  const showTracePanel = !showStencil || Boolean(image.source)

  const toolCursor = vectorToolCursor(activeTool)

  return (
    <div className="relative flex min-h-0 w-full flex-1 bg-[var(--bg-canvas)]">
      {!showStencil && <DrawingToolbar activeTool={activeTool} onTool={setActiveTool} />}
      {showStencil ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <StencilPreview active={active} />
        </div>
      ) : (
        <TraceCanvas
          src={removeBackground && keyedUrl ? keyedUrl : image.url}
          resetKey={imageKey}
          active={active}
          punched={Boolean(removeBackground && keyedUrl)}
          canvasTransform={canvasTransform}
          onCanvasTransform={setCanvasTransform}
          toolCursor={toolCursor}
          filter={`${shownInvert ? 'invert(1) ' : ''}contrast(${
            shownInvert ? `${shownThreshold}%` : shownThreshold / 128
          })`}
          overlay={(slot) => (
            <VectorCanvas
              frame={slot.frame}
              viewport={slot.viewport}
              spaceRef={slot.spaceRef}
              spaceDown={slot.spaceDown}
            />
          )}
        />
      )}

      {showTracePanel && (
      <>
      <button
        type="button"
        aria-expanded={propertiesOpen}
        aria-controls="editor-properties"
        aria-label={propertiesOpen ? 'Close properties' : 'Open properties'}
        onClick={() => setPropertiesOpen((open) => !open)}
        className={`fixed top-1/2 right-0 z-50 flex h-11 w-7 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-[var(--border)] bg-[var(--bg-header)] text-[16px] leading-none text-[var(--text-primary)] shadow-md transition-transform duration-300 md:hidden ${
          propertiesOpen ? '-translate-x-64' : ''
        }`}
      >
        {propertiesOpen ? '>' : '<'}
      </button>
      <div
        id="editor-properties"
        className={`fixed right-0 top-0 z-40 flex h-full w-64 flex-col border-l border-[var(--border)] bg-[var(--bg-sidebar)] shadow-xl transition-transform duration-300 md:static md:inset-auto md:z-auto md:h-auto md:w-72 md:shrink-0 md:translate-x-0 md:shadow-none ${
          propertiesOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
          <span className="text-[13px] font-bold text-[var(--text-primary)]">Properties</span>
          <VectorHistoryButtons
            fallbackUndo={undoTrace}
            fallbackRedo={redoTrace}
            fallbackCanUndo={currentIndex > 0}
            fallbackCanRedo={currentIndex < history.length - 1}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          {!showStencil && <PropertiesPanel />}
          {image.source ? (
            <>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between">
                  <label htmlFor="trace-threshold" className="text-[12px] font-medium text-[var(--text-primary)]">
                    Contrast Threshold
                  </label>
                  <span className="text-[12px] text-[var(--text-muted)]">{shownThreshold}</span>
                </div>
                <input
                  id="trace-threshold"
                  type="range"
                  min="1"
                  max="254"
                  value={shownThreshold}
                  onChange={(event) => {
                    const threshold = clampTraceThreshold(event.target.value)
                    liveThresholdRef.current = threshold
                    setLiveThreshold(threshold)
                  }}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                  onPointerUp={commitThreshold}
                  onPointerCancel={commitThreshold}
                  onKeyUp={(event) => {
                    if (
                      event.key === 'ArrowLeft' ||
                      event.key === 'ArrowRight' ||
                      event.key === 'ArrowUp' ||
                      event.key === 'ArrowDown' ||
                      event.key === 'Home' ||
                      event.key === 'End'
                    ) {
                      commitThreshold()
                    }
                  }}
                  onBlur={commitThreshold}
                  className="w-full"
                  style={{ '--range-pct': `${rangePct}%` }}
                />
                <p className="text-[11px] text-[var(--text-muted)]">
                  Adjust to pick up faint lines or filter background noise.
                </p>
                {isTracing && (
                  <p className="text-[11px] font-medium text-violet-500">Tracing silhouette…</p>
                )}
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-2">
                <span id="remove-background-label" className="text-[12px] font-medium text-[var(--text-primary)]">
                  Remove Background
                </span>
                <Toggle checked={removeBackground} onChange={setRemoveBackground} labelledBy="remove-background-label" />
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                Makes bright white pixels transparent so the grid shows through. Tracing still uses the original image.
              </p>
              {keying && <p className="text-[11px] font-medium text-violet-500">Removing background…</p>}
              {keyError && <p className="text-[11px] text-[var(--text-danger)]">{keyError}</p>}
              <div className="flex items-center justify-between border-t border-[var(--border)] pt-2">
                <label htmlFor="trace-invert" className="text-[12px] font-medium text-[var(--text-primary)]">
                  Invert Colors
                </label>
                <input
                  id="trace-invert"
                  type="checkbox"
                  checked={shownInvert}
                  onChange={(event) => pushHistory(shownThreshold, event.target.checked)}
                  className="h-4 w-4 accent-violet-500"
                />
              </div>
            </>
          ) : (
            <p className="text-[12px] text-[var(--text-muted)]">
              {image.isSvg
                ? 'Tracing properties are not available for SVG vector files.'
                : 'Tracing properties are available for uploaded raster images.'}
            </p>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  )
}
