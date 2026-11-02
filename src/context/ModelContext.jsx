import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deserializeModel } from '../lib/geometryTransfer.js'
import { extractGeometryPayload, generateModelInWorker } from '../lib/geometryWorkerClient.js'
import { useSettings } from './useSettings.js'
import { useVectorCam } from './useVectorEditor.js'
import { ModelContext } from './useModel.js'

/**
 * Owns the current set of generated 3D geometries (blade, handle, bars,
 * stamp, stencil, wall text). Generation itself happens entirely on the
 * geometry Web Worker (see workers/geometryWorker.js) — this context just
 * ships a geometry-only settings payload + RAW traced paths over, waits
 * for typed-array results, and turns them back into real
 * `THREE.BufferGeometry` instances
 * for the renderer (`CutterMesh`/`WallTextMesh`) and for STL export to
 * share, so both always show/export the exact same geometry.
 *
 * Deliberately sends `rawPaths` (the un-fit, as-traced silhouette) rather
 * than a main-thread preview fit: the Worker fits those paths so they ARE
 * the inner cutting cavity at the requested width/height
 * (`fitInnerCavityPaths`), then expands blade thickness and handle width
 * outward from that cavity.
 *
 * Builds are pointer-aware. While any pointer is down (a slider drag, a
 * spinner hold), setting changes are queued and the worker is not started.
 * The queued job runs once, on pointerup / pointercancel. Changes that
 * arrive with the pointer up — typing, preset loads — wait 50ms so React
 * can commit a burst of updates as one build. Each build aborts the
 * previous AbortController, and seqRef drops stale resolutions so an
 * older WASM result cannot replace a newer model.
 */

const BATCH_MS = 50

function disposeModel(model) {
  if (!model) return
  for (const geo of Object.values(model)) {
    geo?.dispose?.()
  }
}

export function ModelProvider({ children }) {
  const { settings, rawPaths, pathRoles } = useSettings()
  const { camStrokes, camReplaceBase } = useVectorCam()
  const [model, setModel] = useState(null)
  const [stencilSheet, setStencilSheet] = useState(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const seqRef = useRef(0)
  const timerRef = useRef(null)
  const abortRef = useRef(null)
  const prevModelRef = useRef(null)
  const isPointerDown = useRef(false)
  const pendingJobRef = useRef(null)

  // Dispose the previous GPU buffers when a new model replaces them.
  // Intentionally not in an effect-cleanup: React StrictMode would
  // dispose the live geometry on the fake unmount.
  useEffect(() => {
    if (prevModelRef.current && prevModelRef.current !== model) {
      disposeModel(prevModelRef.current)
    }
    prevModelRef.current = model
  }, [model])

  const executeBuild = useCallback((job) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingJobRef.current = null

    const paths = job?.rawPaths
    const lightbox = job?.settings?.thingToMake === 'lightbox'
    if ((!paths || paths.length === 0) && !lightbox) {
      abortRef.current?.abort()
      abortRef.current = null
      seqRef.current += 1
      setModel(null)
      setStencilSheet(null)
      setIsGenerating(false)
      return
    }

    // Bump the sequence before aborting so the cancelled build's finally
    // cannot clear isGenerating after this one has taken the flag.
    const mySeq = ++seqRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setIsGenerating(true)

    generateModelInWorker(paths, extractGeometryPayload(job.settings), {
      signal: controller.signal,
      roles: job.pathRoles,
      drawings: job.drawings,
      replaceBase: job.replaceBase,
      // Pulled off the full settings object. `extractGeometryPayload`
      // omits path arrays so they are packed and transferred, not cloned.
      stampArtworkPaths: job.settings?.stampArtworkPaths,
    })
      .then((payload) => {
        if (mySeq !== seqRef.current) return
        if (!payload || payload.skipped) return
        setModel(payload.model ? deserializeModel(payload.model) : null)
        setStencilSheet(payload.stencil ?? null)
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        if (mySeq !== seqRef.current) return
        console.error('[ModelContext] model generation failed:', err)
      })
      .finally(() => {
        if (mySeq === seqRef.current) setIsGenerating(false)
      })
  }, [])

  useEffect(() => {
    const onPointerDown = () => {
      isPointerDown.current = true
      // A 50ms batch timer must not fire underneath an in-progress drag.
      // The job stays in pendingJobRef and runs on release.
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const onPointerUp = () => {
      isPointerDown.current = false
      const job = pendingJobRef.current
      if (!job) return
      executeBuild(job)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [executeBuild])

  useEffect(() => {
    const lightbox = settings.thingToMake === 'lightbox'
    if ((!rawPaths || rawPaths.length === 0) && !lightbox) {
      pendingJobRef.current = null
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      abortRef.current?.abort()
      abortRef.current = null
      seqRef.current += 1
      setModel(null)
      setStencilSheet(null)
      setIsGenerating(false)
      return
    }

    const job = { settings, rawPaths, pathRoles, drawings: camStrokes, replaceBase: camReplaceBase }
    if (isPointerDown.current) {
      pendingJobRef.current = job
      // Drop a build that is already on the worker. Its result is stale
      // for the drag, and leaving it running locks the UI until pointerup.
      if (abortRef.current) {
        seqRef.current += 1
        abortRef.current.abort()
        abortRef.current = null
        setIsGenerating(false)
      }
      return
    }

    pendingJobRef.current = job
    if (timerRef.current) clearTimeout(timerRef.current)
    const timerId = window.setTimeout(() => {
      if (timerRef.current !== timerId) return
      timerRef.current = null
      if (isPointerDown.current) return
      const next = pendingJobRef.current
      if (!next) return
      executeBuild(next)
    }, BATCH_MS)
    timerRef.current = timerId

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [settings, rawPaths, pathRoles, camStrokes, camReplaceBase, executeBuild])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      seqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const value = useMemo(
    () => ({ model, stencilSheet, isGenerating }),
    [model, stencilSheet, isGenerating],
  )

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>
}
