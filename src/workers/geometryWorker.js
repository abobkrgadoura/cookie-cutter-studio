import {
  buildLightboxGeometry,
  buildStencilModel,
  fitInnerCavityPaths,
  generateFullCutterModel,
} from '../lib/cutterGeometry.js'
import { unionDrawingsOntoFittedCavity } from '../lib/vectorStroke.js'
import { loadFontsForWallTexts } from '../lib/fontCache.js'
import {
  collectPathTransferables,
  collectTransferables,
  packPaths,
  releaseTransferredGeometry,
  serializeModel,
  unpackPaths,
  unpackRoles,
} from '../lib/geometryTransfer.js'
import { beginWasmScope, getWasmLeakCount, initManifold, sweepWasmScope } from '../lib/manifoldEngine.js'
import { parseSvgArtwork } from '../lib/svgParser.js'
import { traceImageSource } from '../lib/vectorizer.js'

// Dedicated workers have no DOMParser (Chrome still omits it). SVGLoader
// constructs one, so install a pure-JS parser on first SVG parse when the
// host doesn't provide it. A native DOMParser is left in place.
async function ensureWorkerDomParser() {
  if (typeof DOMParser !== 'undefined') return
  const { DOMParser: XmlDOMParser } = await import('@xmldom/xmldom')
  if (typeof DOMParser === 'undefined') globalThis.DOMParser = XmlDOMParser
}

const manifoldReady = initManifold()

// Latest GENERATE_MODEL id seen by this worker. Used together with
// `abortedIds` to drop queued or explicitly cancelled builds so a slider
// drag cannot pile up multiple WASM jobs.
let latestGenerateId = 0
const abortedIds = new Set()

// `await` on an already-resolved promise only drains microtasks. Worker
// `postMessage` events are macrotasks, so an ABORT_MODEL queued during
// synchronous Clipper/CSG stays invisible until we yield the task queue.
function yieldToMessageQueue() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Dedicated Web Worker that owns every CPU-heavy step of turning an
 * uploaded image (or an edited setting) into 3D geometry: raster tracing
 * (Moore-Neighbor + RDP/Taubin/Chaikin destaircase), every Clipper
 * boolean/offset operation, manifold-3d extrusion + CSG (including wall text),
 * and mesh cleanup (`mergeVertices` / `toCreasedNormals`). None of that
 * runs on the main thread.
 *
 * Protocol: every request carries an `id`; every response echoes it back so
 * the client can match responses to requests (and safely ignore stale ones
 * if a newer request superseded it before this one finished).
 */

async function getFontsSafe(settings) {
  try {
    const wallTexts = settings.wallTextEnabled ? settings.wallTexts : []
    return await loadFontsForWallTexts(wallTexts)
  } catch (err) {
    console.error('[geometryWorker] font loading failed:', err)
    return new Map()
  }
}

function disposeModel(model, transferred = false) {
  if (!model) return
  for (const geo of Object.values(model)) {
    if (!geo) continue
    // Transferred position/normal/index buffers are detached. Drop the
    // attribute objects first so dispose cannot read or .delete() them.
    if (transferred) releaseTransferredGeometry(geo)
    geo.dispose?.()
  }
}

function postPackedPaths(id, paths, roles) {
  const packedPaths = packPaths(paths, roles)
  self.postMessage(
    { type: 'TRACE_RESULT', id, packedPaths },
    collectPathTransferables(packedPaths),
  )
}

function packStencilPayload(sheet) {
  if (!sheet) return null
  return {
    boardWidth: sheet.boardWidth,
    boardHeight: sheet.boardHeight,
    margin: sheet.margin,
    rows: sheet.rows,
    columns: sheet.columns,
    cellWidth: sheet.cellWidth,
    cellHeight: sheet.cellHeight,
    gapX: sheet.gapX,
    gapY: sheet.gapY,
    scale: sheet.scale,
    sourceIslands: sheet.sourceIslands,
    openIslands: sheet.openIslands,
    bridgeMarkers: Array.isArray(sheet.bridgeMarkers) ? sheet.bridgeMarkers : [],
    cutPaths: packPaths(sheet.cutPaths),
  }
}

self.onmessage = async (event) => {
  const { type, id } = event.data || {}

  try {
    if (type === 'TRACE_IMAGE') {
      const { bitmap, options } = event.data
      const result = traceImageSource(bitmap, options)
      bitmap.close?.()
      postPackedPaths(id, result?.paths)
      return
    }

    if (type === 'PARSE_SVG') {
      await ensureWorkerDomParser()
      const artwork = parseSvgArtwork(event.data?.svg)
      postPackedPaths(id, artwork.paths, artwork.roles)
      return
    }

    if (type === 'ABORT_MODEL') {
      if (id != null) {
        abortedIds.add(id)
        for (const abortedId of abortedIds) {
          if (abortedId < id) abortedIds.delete(abortedId)
        }
      }
      return
    }

    if (type === 'GENERATE_MODEL') {
      const scope = beginWasmScope()
      const { packedPaths, rawPaths, settings, drawings, replaceBase, packedStampArtwork } = event.data
      const stampArtworkPaths = unpackPaths(packedStampArtwork)
      const jobSettings =
        stampArtworkPaths.length > 0 ? { ...settings, stampArtworkPaths } : settings
      latestGenerateId = Math.max(latestGenerateId, id)
      const isAborted = () => id !== latestGenerateId || abortedIds.has(id)
      // Yield so a backlog of GENERATE/ABORT messages can mark this id stale
      // before the next Clipper or CSG stage starts. The worker is one
      // thread, so a slider burst piles up here instead of inside WASM.
      const checkpoint = async () => {
        await yieldToMessageQueue()
        return isAborted()
      }

      let model = null
      let stencilPayload = null
      let transferred = false
      let outcome = 'skipped'

      try {
        const sourcePaths = packedPaths ? unpackPaths(packedPaths) : rawPaths
        const roles = unpackRoles(packedPaths)

        if (!isAborted() && !(await checkpoint())) {
          await manifoldReady
          if (!isAborted() && !(await checkpoint())) {
            if (jobSettings?.thingToMake === 'stencil') {
              const built = buildStencilModel(sourcePaths, jobSettings, roles, drawings, Boolean(replaceBase))
              model = built.geometry ? { stencil: built.geometry } : null
              stencilPayload = packStencilPayload(built.sheet)
              outcome = 'result'
            } else if (jobSettings?.thingToMake === 'lightbox') {
              model = buildLightboxGeometry(jobSettings, sourcePaths || [])
              outcome = 'result'
            } else {
              const fittedPaths = fitInnerCavityPaths(sourcePaths, jobSettings)
              const basePaths = unionDrawingsOntoFittedCavity(
                sourcePaths,
                fittedPaths,
                drawings,
                jobSettings,
                Boolean(replaceBase),
              )
              if (!isAborted() && !(await checkpoint())) {
                const fontsByKey = await getFontsSafe(jobSettings)
                if (!isAborted() && !(await checkpoint())) {
                  model = generateFullCutterModel(basePaths, jobSettings, fontsByKey)
                  outcome = 'result'
                }
              }
            }
          }
        }

        if (outcome === 'result' && (isAborted() || (await checkpoint()))) {
          outcome = 'skipped'
        }

        if (outcome === 'result') {
          const serialized = serializeModel(model)
          const transferables = collectTransferables(serialized)
          const cutPacked = stencilPayload?.cutPaths
          if (cutPacked) {
            for (const buffer of collectPathTransferables(cutPacked)) transferables.push(buffer)
          }
          if (isAborted()) {
            outcome = 'skipped'
          } else {
            self.postMessage(
              { type: 'MODEL_RESULT', id, model: serialized, stencil: stencilPayload },
              transferables,
            )
            transferred = true
          }
        }
      } catch (err) {
        outcome = err?.name === 'AbortError' ? 'skipped' : 'error'
        if (outcome === 'error') {
          console.error('[geometryWorker] request failed:', err)
          self.postMessage({ type: 'ERROR', id, error: err?.message || String(err) })
        }
      } finally {
        disposeModel(model, transferred)
        model = null
        const released = sweepWasmScope(scope)
        if (released > 0) {
          console.warn(
            `[geometryWorker] job ${id} deleted ${released} leaked WASM handle(s); live=${getWasmLeakCount()}`,
          )
        }
        abortedIds.delete(id)
        if (outcome === 'skipped') {
          self.postMessage({ type: 'MODEL_SKIPPED', id })
        }
      }
      return
    }

    self.postMessage({ type: 'ERROR', id, error: `Unknown message type: ${type}` })
  } catch (err) {
    console.error('[geometryWorker] request failed:', err)
    self.postMessage({ type: 'ERROR', id, error: err?.message || String(err) })
  }
}
