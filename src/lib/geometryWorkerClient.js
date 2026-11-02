import { collectPathTransferables, packPaths, unpackPaths, unpackRoles } from './geometryTransfer.js'

const GEOMETRY_NUMBER_KEYS = [
  'width',
  'height',
  'bladeDepth',
  'bladeThickness',
  'cutterChamferWidth',
  'cutterChamferHeight',
  'handleHeight',
  'handleWidth',
  'stampBackThickness',
  'stampImprintDepth',
  'stampImprintThickness',
  'stampBaseOffset',
  'stampClearance',
  'stampArtworkMargin',
  'sableDepth',
  'sableThickness',
  'sableTipWidth',
  'sableChamfer',
  'sableStampHeight',
  'sablePatternThickness',
  'sableInnerHole',
  'sableBridgeWidth',
  'sableBridgeFlare',
  'sableBridgeDepth',
  'stencilBoardWidth',
  'stencilBoardHeight',
  'stencilMargin',
  'designWidth',
  'designHeight',
  'rows',
  'columns',
  'cutThickness',
  'bridgeWidth',
  'bridgeCount',
  'boxWidth',
  'boxHeight',
  'boxDepth',
  'wallThickness',
]

const GEOMETRY_BOOLEAN_KEYS = [
  'aspectLocked',
  'mirrorDesign',
  'sharpCutter',
  'centerBarsEnabled',
  'centerBarsForceSolid',
  'deleteOuterEdge',
  'invertStamp',
  'sableLineDrawingMode',
  'sableStampMode',
  'sableBridgesEnabled',
  'wallTextEnabled',
  'designAspectLocked',
  'stencilBridges',
]

const GEOMETRY_STRING_KEYS = [
  'thingToMake',
  'handleShape',
  'sableBridgeType',
  'stencilArtwork',
  'bridgeStrategy',
  'placement',
  'stampStyle',
  'batteryType',
]

const LIGHTBOX_EXPORT_PART_KEYS = ['walls', 'base', 'pillar', 'imagePlate']

const CENTER_BAR_NUMBER_KEYS = ['angle', 'position', 'width', 'height']

const WALL_TEXT_NUMBER_KEYS = [
  'fontSize',
  'textExtrusionDistance',
  'position',
  'lineDistance',
  'letterSpacing',
  'curveSegments',
]

const WALL_TEXT_STRING_KEYS = ['text', 'font', 'fontWeight']

function takeNumbers(source, keys, target) {
  if (!source) return
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) target[key] = value
  }
}

function takeBooleans(source, keys, target) {
  if (!source) return
  for (const key of keys) {
    if (typeof source[key] === 'boolean') target[key] = source[key]
  }
}

function takeStrings(source, keys, target) {
  if (!source) return
  for (const key of keys) {
    if (typeof source[key] === 'string') target[key] = source[key]
  }
}

/**
 * Geometry-only snapshot of `settings`. UI fields (unit, size mode,
 * trace threshold, dimension overlay, record ids) stay on the main
 * thread so a slider tick does not structured-clone the whole object.
 */
export function extractGeometryPayload(settings) {
  if (!settings || typeof settings !== 'object') return {}
  const payload = {}
  takeNumbers(settings, GEOMETRY_NUMBER_KEYS, payload)
  takeBooleans(settings, GEOMETRY_BOOLEAN_KEYS, payload)
  takeStrings(settings, GEOMETRY_STRING_KEYS, payload)

  if (payload.centerBarsEnabled === true && Array.isArray(settings.centerBars)) {
    payload.centerBars = settings.centerBars.map((bar) => {
      const out = {}
      takeNumbers(bar, CENTER_BAR_NUMBER_KEYS, out)
      return out
    })
  }

  if (payload.wallTextEnabled === true && Array.isArray(settings.wallTexts)) {
    payload.wallTexts = settings.wallTexts.map((item) => {
      const out = {}
      takeStrings(item, WALL_TEXT_STRING_KEYS, out)
      takeNumbers(item, WALL_TEXT_NUMBER_KEYS, out)
      return out
    })
  }

  if (settings.exportParts && typeof settings.exportParts === 'object') {
    const exportParts = {}
    takeBooleans(settings.exportParts, LIGHTBOX_EXPORT_PART_KEYS, exportParts)
    if (Object.keys(exportParts).length > 0) payload.exportParts = exportParts
  }

  if (Array.isArray(settings.manualBridges)) {
    payload.manualBridges = []
    for (const entry of settings.manualBridges) {
      const x1 = Number(entry?.p1?.x)
      const y1 = Number(entry?.p1?.y)
      const x2 = Number(entry?.p2?.x)
      const y2 = Number(entry?.p2?.y)
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue
      payload.manualBridges.push({
        p1: { x: x1, y: y1 },
        p2: { x: x2, y: y2 },
      })
    }
  }

  return payload
}

/**
 * Thin promise-based client around the single shared `geometryWorker`
 * instance. Keeping this as a plain module (not a hook) lets both
 * `SettingsContext` (image tracing) and `ModelContext` (model generation)
 * share one worker and one in-flight-request table without needing to be
 * nested in any particular provider order.
 */

let worker = null
let nextId = 1
const pending = new Map()

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/geometryWorker.js', import.meta.url), {
      type: 'module',
      name: 'cutter-geometry-worker',
    })
    worker.onmessage = (event) => {
      const { type, id, error } = event.data || {}
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (type === 'ERROR') {
        entry.reject(new Error(error || 'Geometry worker error'))
      } else if (type === 'MODEL_SKIPPED') {
        entry.resolve({ model: null, skipped: true })
      } else {
        entry.resolve(event.data)
      }
    }
    worker.onerror = (event) => {
      const failed = worker
      // Drop the dead instance before rejecting so a caller that retries
      // inside a rejection handler gets a fresh worker from getWorker().
      worker = null
      failed?.terminate()
      const err = new Error(event?.message || 'Geometry worker crashed')
      const entries = [...pending.values()]
      pending.clear()
      for (const entry of entries) entry.reject(err)
    }
  }
  return worker
}

function createAbortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function send(message, transfer) {
  const w = getWorker()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ ...message, id }, transfer || [])
  })
}

function decodePackedPaths(result) {
  return unpackPaths(result?.packedPaths)
}

/**
 * Traces an already-decoded `ImageBitmap` (transferred, not copied) into
 * exact pixel-boundary 2D polygon paths, entirely on the worker thread.
 * The worker returns those loops as transferred typed arrays
 * (`packPaths`); this decodes them back into `{x,y}` loops.
 */
export async function traceImageInWorker(bitmap, options) {
  const result = await send({ type: 'TRACE_IMAGE', bitmap, options }, [bitmap])
  return decodePackedPaths(result)
}

/**
 * Tessellates an SVG document on the worker and returns the same
 * `{x,y}` loops `parseSvgToPaths` produces. The path buffer is
 * transferred, then decoded here.
 */
export async function parseSvgInWorker(svg) {
  const result = await send({ type: 'PARSE_SVG', svg })
  return {
    paths: decodePackedPaths(result),
    roles: unpackRoles(result?.packedPaths),
  }
}

export function decodeStencilSheet(stencil) {
  if (!stencil) return null
  const { cutPaths, ...rest } = stencil
  return {
    ...rest,
    cutPaths: unpackPaths(cutPaths),
  }
}

/**
 * Runs the full pipeline on the worker thread — fitting `rawPaths` (the
 * raw, un-fit traced/vectorized silhouette) so its resulting INNER cutting
 * cavity matches `settings.width` x `settings.height` exactly (see
 * `cutterGeometry.js`'s `fitInnerCavityPaths`), then the Clipper
 * offset/boolean pipeline + extrusion + wall-text embossing — and returns
 * serialized geometry data (raw typed arrays — see geometryTransfer.js)
 * ready to be turned back into `THREE.BufferGeometry` on the main thread.
 *
 * `rawPaths` is packed into typed arrays and transferred (zero-copy)
 * instead of structured-cloning thousands of `{x,y}` objects.
 * `stampArtworkPaths` uses the same packing. It is not copied into the
 * geometry settings object, so a slider tick cannot structured-clone the
 * stamp SVG.
 */
export async function generateModelInWorker(rawPaths, settings, options) {
  const signal = options?.signal
  if (signal?.aborted) throw createAbortError()

  const w = getWorker()
  const id = nextId++

  const result = await new Promise((resolve, reject) => {
    let settled = false
    let sent = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      pending.delete(id)
      fn(value)
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      pending.delete(id)
      if (sent) {
        try {
          w.postMessage({ type: 'ABORT_MODEL', id })
        } catch (err) {
          console.error('[geometryWorkerClient] failed to post ABORT_MODEL:', err)
        }
      }
      reject(createAbortError())
    }

    if (signal) signal.addEventListener('abort', onAbort)
    if (signal?.aborted) {
      onAbort()
      return
    }

    pending.set(id, {
      resolve: (data) => finish(resolve, data),
      reject: (err) => finish(reject, err),
    })
    sent = true
    try {
      const packedPaths = packPaths(rawPaths, options?.roles)
      const geometrySettings = extractGeometryPayload(settings)
      const drawings = options?.drawings?.length ? options.drawings : null
      // `packedPaths` keeps defining the fit frame. With `replaceBase` the
      // cavity comes from `drawings` instead of from those loops.
      const replaceBase = Boolean(options?.replaceBase)
      const stampArtworkPaths = options?.stampArtworkPaths ?? settings?.stampArtworkPaths
      const packedStampArtwork = packPaths(stampArtworkPaths)
      const transfer = collectPathTransferables(packedPaths)
      for (const buffer of collectPathTransferables(packedStampArtwork)) transfer.push(buffer)
      w.postMessage(
        {
          type: 'GENERATE_MODEL',
          id,
          packedPaths,
          settings: geometrySettings,
          drawings,
          replaceBase,
          packedStampArtwork,
        },
        transfer,
      )
    } catch (err) {
      sent = false
      finish(reject, err)
    }
  })
  if (result?.skipped) return { skipped: true, model: null, stencil: null }
  return { model: result.model, stencil: decodeStencilSheet(result.stencil) }
}
