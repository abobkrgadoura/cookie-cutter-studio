import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from './useSettings.js'
import { VectorCamContext, VectorEditorContext } from './useVectorEditor.js'
import { uid } from '../lib/constants.js'
import { clampScreenZoom } from '../lib/cadViewport.js'
import { measureFit } from '../lib/pathMetrics.js'
import { isBasePristine, tracePathsToBaseEntities } from '../lib/vectorBase.js'
import {
  DEFAULT_ERASER_MM,
  DEFAULT_STROKE_MM,
  VECTOR_TOOLS,
  clampEraserMm,
  clampStrokeMm,
  editorEntitiesToTraceStrokes,
  entityGroupIds,
  expandSelectionIds,
  normalizeLineStyle,
  scaleEntitiesToSize,
} from '../lib/vectorEntities.js'

const PAN_LIMIT = 20000
const EMPTY_STROKES = []
const EMPTY_ENTITIES = []
const EMPTY_SEED = { paths: null, entities: EMPTY_ENTITIES }
const TOOL_IDS = new Set(VECTOR_TOOLS.map((tool) => tool.id))

/** Typed dimensions outside this range are ignored, not clamped, so a half-typed "0" cannot collapse a shape. */
const MIN_DIMENSION_MM = 0.1
const MAX_DIMENSION_MM = 2000

function clampPan(pan) {
  const x = Number(pan?.x)
  const y = Number(pan?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 }
  return {
    x: Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, x)),
    y: Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, y)),
  }
}

function imageKeyOf(image) {
  return `${image?.url ?? ''}|${image?.name ?? ''}|${image?.isSvg ? 'svg' : 'raster'}`
}

/** Canvas edits kept behind and ahead of the live entities array. */
const HISTORY_LIMIT = 3
/**
 * Spinner holds and typed dimensions fire many times a second. Events closer
 * than this are one undo step. Pointer drags never reach this window: the
 * canvas previews them locally and commits once, on pointerup.
 */
const HISTORY_BURST_MS = 300

function pushLimited(stack, entry, limit) {
  const next = stack.length >= limit ? stack.slice(stack.length - limit + 1) : stack.slice()
  next.push(entry)
  return next
}

/**
 * Decides whether `current` entities should be pushed before a write.
 * A string key collapses a numeric burst. Anything else is its own step.
 */
function shouldRecordHistory(coalesceRef, coalesceKey) {
  if (typeof coalesceKey === 'string') {
    const now = performance.now()
    const open = coalesceRef.current
    if (open && open.burst === coalesceKey && now - open.at < HISTORY_BURST_MS) {
      open.at = now
      return false
    }
    coalesceRef.current = { burst: coalesceKey, at: now }
    return true
  }

  coalesceRef.current = null
  return true
}

function retainLiveSelection(setSelectedEntityIds, entities) {
  const live = new Set(entities.map((entity) => entity.id))
  setSelectedEntityIds((ids) => {
    if (!ids.length) return ids
    const kept = ids.filter((id) => live.has(id))
    return kept.length === ids.length ? ids : kept
  })
}

function bridgeList(value) {
  return Array.isArray(value) ? value : []
}

/** The live list that `entry` is about to replace, kept so redo can put it back. */
function stepAside(entry, entitiesRef, bridgesRef) {
  if (entry?.kind === 'bridges') {
    return { kind: 'bridges', snapshot: bridgeList(bridgesRef.current) }
  }
  return { kind: 'entities', snapshot: entitiesRef.current }
}

/** Nudge applied to each paste, in millimetres, so the copy does not sit on the original. */
const PASTE_OFFSET_MM = 5

function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'TEXTAREA' || target.isContentEditable) return true
  if (tag === 'INPUT' && target.type !== 'range' && target.type !== 'checkbox') return true
  return false
}

function isTraceableFile(file) {
  if (!file) return false
  const type = file.type ?? ''
  const name = (file.name ?? '').toLowerCase()
  return type.startsWith('image/') || name.endsWith('.svg')
}

/** An image or SVG on the OS clipboard belongs to the importer, not entity paste. */
function clipboardCarriesImage(clipboardData) {
  const files = clipboardData?.files
  if (files) {
    for (const file of files) {
      if (isTraceableFile(file)) return true
    }
  }
  const items = clipboardData?.items
  if (!items) return false
  for (const item of items) {
    if (item.kind !== 'file') continue
    // Type only. getAsFile() can consume the item the image importer still needs.
    if ((item.type ?? '').startsWith('image/')) return true
  }
  return false
}

function pasteDelta(mmPerUnit) {
  const sx = Number(mmPerUnit?.x)
  const sy = Number(mmPerUnit?.y)
  if (sx > 0 && sy > 0) return { x: PASTE_OFFSET_MM / sx, y: PASTE_OFFSET_MM / sy }
  return { x: PASTE_OFFSET_MM, y: PASTE_OFFSET_MM }
}

function translateRing(ring, dx, dy) {
  if (!ring?.length) return []
  const moved = []
  for (const point of ring) {
    const x = Number(point?.x)
    const y = Number(point?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    moved.push({ x: x + dx, y: y + dy })
  }
  return moved
}

/**
 * Geometry-only copy. `base` stays behind: a pasted silhouette is a new
 * drawing, and a re-trace must not delete it.
 */
function cloneEntityGeometry(entity, dx, dy) {
  const points = translateRing(entity?.points, dx, dy)
  if (points.length < 2) return null
  const clone = {
    type: entity.type || 'path',
    points,
    closed: Boolean(entity.closed),
    baked: Boolean(entity.baked),
    strokeWidth: clampStrokeMm(entity.strokeWidth),
    lineStyle: normalizeLineStyle(entity.lineStyle),
  }
  if (entity.holes?.length) {
    const holes = []
    for (const hole of entity.holes) {
      const ring = translateRing(hole, dx, dy)
      if (ring.length) holes.push(ring)
    }
    if (holes.length) clone.holes = holes
  }
  if (entity.groupId) clone.groupId = entity.groupId
  return clone
}

/**
 * Deep copy. With `assignIds`, every clone gets a fresh id and a group that
 * still has two or more members gets a new `groupId`, so the paste stays
 * linked to itself and does not join the shapes it was copied from.
 */
function cloneEntityList(entities, dx, dy, assignIds) {
  const clones = []
  for (const entity of entities) {
    const clone = cloneEntityGeometry(entity, dx, dy)
    if (!clone) continue
    clone.id = assignIds ? uid() : entity.id
    clones.push(clone)
  }
  if (!assignIds) return clones

  const counts = new Map()
  for (const clone of clones) {
    if (!clone.groupId) continue
    counts.set(clone.groupId, (counts.get(clone.groupId) ?? 0) + 1)
  }
  const remapped = new Map()
  for (const clone of clones) {
    const members = clone.groupId ? counts.get(clone.groupId) : 0
    if (!(members > 1)) {
      delete clone.groupId
      continue
    }
    let groupId = remapped.get(clone.groupId)
    if (!groupId) {
      groupId = uid()
      remapped.set(clone.groupId, groupId)
    }
    clone.groupId = groupId
  }
  return clones
}

/** Two bridge lists describe the same tabs. Point objects may differ. */
function sameBridgeList(a, b) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (
      left?.p1?.x !== right?.p1?.x ||
      left?.p1?.y !== right?.p1?.y ||
      left?.p2?.x !== right?.p2?.x ||
      left?.p2?.y !== right?.p2?.y
    ) {
      return false
    }
  }
  return true
}

export function VectorEditorProvider({ children }) {
  const { image, rawPaths, settings, patch, view } = useSettings()
  const imageKey = imageKeyOf(image)
  const [trackedKey, setTrackedKey] = useState(imageKey)
  const [entities, setEntities] = useState([])
  const [activeTool, setActiveToolState] = useState('select')
  const [selectedEntityIds, setSelectedEntityIds] = useState([])
  const [defaultStrokeWidth, setDefaultStrokeWidth] = useState(DEFAULT_STROKE_MM)
  const [defaultLineStyle, setDefaultLineStyle] = useState('solid')
  // Properties Panel values at the last render. `commitEntity` reads these
  // at call time so a stroke started after a thickness change inherits it.
  const panelStrokeRef = useRef(DEFAULT_STROKE_MM)
  const panelStyleRef = useRef('solid')
  const [eraserSizeMm, setEraserSizeMm] = useState(DEFAULT_ERASER_MM)
  const [clipboard, setClipboard] = useState(null)
  const [canvasTransform, setCanvasTransformState] = useState({ pan: { x: 0, y: 0 }, zoom: 1 })
  // The silhouette exactly as the last trace produced it. `paths` is the
  // `rawPaths` array it came from; `entities` are the editable regions made
  // from it. Edits never touch `rawPaths`, which keeps defining the fit.
  const [baseSeed, setBaseSeed] = useState(EMPTY_SEED)
  // Previous and next edits. Each entry is `{ kind, snapshot }`:
  // `entities` snapshots the canvas list, `bridges` snapshots
  // `settings.manualBridges`. Arrays are stored by reference: every edit
  // replaces the list, so unchanged paths are shared instead of copied.
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const pastRef = useRef(past)
  const futureRef = useRef(future)
  const bridgesRef = useRef(bridgeList(settings.manualBridges))
  const coalesceRef = useRef(null)
  const entitiesRef = useRef(entities)
  // Mirrors `clipboard` for paste handlers. Geometry is state so the Paste
  // button updates; the ref is what the shortcut reads at event time.
  const clipboardRef = useRef(null)

  // Raster traces and loaded presets both become editable silhouettes.
  // A user SVG stays parsed geometry and is not turned into entities.
  const fromRaster = Boolean(image?.source) && !image?.isSvg
  const fromPreset = Boolean(image?.preset)
  const editable = fromRaster || fromPreset
  const tracedPaths = editable ? rawPaths : null

  if (trackedKey !== imageKey) {
    setTrackedKey(imageKey)
    setEntities([])
    setSelectedEntityIds([])
    setBaseSeed(EMPTY_SEED)
    setCanvasTransformState({ pan: { x: 0, y: 0 }, zoom: 1 })
    if (past.length || future.length) {
      setPast([])
      setFuture([])
    }
    if (clipboard) setClipboard(null)
  } else if (baseSeed.paths !== tracedPaths) {
    // A trace finished (first upload or a threshold / invert re-trace). The
    // old silhouette and any edits to it are replaced by the fresh trace;
    // everything the user drew on top is kept.
    const seeded = tracedPaths ? tracePathsToBaseEntities(tracedPaths) : EMPTY_ENTITIES
    setBaseSeed({ paths: tracedPaths, entities: seeded })
    const kept = entities.filter((entity) => !entity.base)
    if (seeded.length || kept.length !== entities.length) {
      const next = [...seeded, ...kept]
      const live = new Set(next.map((entity) => entity.id))
      setEntities(next)
      // The silhouette was replaced by a new trace. Restoring an older
      // entities array would put the previous silhouette back on this image.
      if (past.length || future.length) {
        setPast([])
        setFuture([])
      }
      setSelectedEntityIds((ids) => {
        const alive = ids.filter((id) => live.has(id))
        return alive.length === ids.length ? ids : alive
      })
    }
  }

  const selectedRef = useRef(selectedEntityIds)
  // Millimetres per editor unit, from the ORIGINAL trace. Editing the
  // silhouette must not move this, or erasing a corner would rescale the
  // cavity back up to the requested width and height.
  const mmPerUnit = useMemo(() => {
    if (!rawPaths?.length) return null
    const fit = measureFit(rawPaths, settings.width, settings.height, settings.aspectLocked)
    if (!fit) return null
    return { x: Math.abs(fit.sx), y: Math.abs(fit.sy) }
  }, [rawPaths, settings.width, settings.height, settings.aspectLocked])
  const mmPerUnitRef = useRef(mmPerUnit)
  useLayoutEffect(() => {
    selectedRef.current = selectedEntityIds
  }, [selectedEntityIds])
  useLayoutEffect(() => {
    entitiesRef.current = entities
  }, [entities])
  useLayoutEffect(() => {
    pastRef.current = past
    futureRef.current = future
  }, [past, future])
  useLayoutEffect(() => {
    bridgesRef.current = bridgeList(settings.manualBridges)
  }, [settings.manualBridges])
  useLayoutEffect(() => {
    coalesceRef.current = null
  }, [imageKey, baseSeed])
  useLayoutEffect(() => {
    clipboardRef.current = clipboard
  }, [clipboard])
  useLayoutEffect(() => {
    mmPerUnitRef.current = mmPerUnit
  }, [mmPerUnit])

  const setActiveTool = useCallback((tool) => {
    if (TOOL_IDS.has(tool)) setActiveToolState(tool)
  }, [])

  const setCanvasTransform = useCallback((next) => {
    setCanvasTransformState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      const zoom = clampScreenZoom(resolved?.zoom)
      const pan = clampPan(resolved?.pan)
      if (prev.zoom === zoom && prev.pan.x === pan.x && prev.pan.y === pan.y) return prev
      return { zoom, pan }
    })
  }, [])

  const selectOnly = useCallback((id) => {
    if (!id) {
      setSelectedEntityIds([])
      return
    }
    // Islands of the traced silhouette select together.
    const ids = entityGroupIds(entitiesRef.current, id)
    setSelectedEntityIds(ids.length ? ids : [id])
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedEntityIds([])
  }, [])

  /** Shift-click. Adds or removes `id` and every entity that shares its group. */
  const toggleSelected = useCallback((id) => {
    if (!id) return
    const members = entityGroupIds(entitiesRef.current, id)
    if (!members.length) return
    const memberSet = new Set(members)
    setSelectedEntityIds((current) => {
      const allIn = members.every((member) => current.includes(member))
      if (allIn) return current.filter((existing) => !memberSet.has(existing))
      return current.filter((existing) => !memberSet.has(existing)).concat(members)
    })
  }, [])

  const pushPast = useCallback((entry) => {
    const stacked = pushLimited(pastRef.current, entry, HISTORY_LIMIT)
    pastRef.current = stacked
    setPast(stacked)
    if (futureRef.current.length) {
      futureRef.current = []
      setFuture([])
    }
  }, [])

  const applyEntry = useCallback((entry) => {
    if (entry?.kind === 'bridges') {
      const list = bridgeList(entry.snapshot)
      bridgesRef.current = list
      patch({ manualBridges: list })
      return
    }
    const restored = entry?.kind === 'entities' ? entry.snapshot : []
    entitiesRef.current = restored
    setEntities(restored)
    retainLiveSelection(setSelectedEntityIds, restored)
  }, [patch])

  const commitEntities = useCallback((next, coalesceKey) => {
    const current = entitiesRef.current
    if (next === current) return false
    if (shouldRecordHistory(coalesceRef, coalesceKey)) {
      pushPast({ kind: 'entities', snapshot: current })
    }
    entitiesRef.current = next
    setEntities(next)
    return true
  }, [pushPast])

  /**
   * Manual stencil bridges live on `settings.manualBridges`, not in the
   * entity list. A finished drag still has to land on these past/future
   * stacks, or Ctrl+Z skips the bridge and undoes the trace threshold.
   * `next` may be the replacement list or `(current) => next`.
   */
  const commitManualBridges = useCallback((nextOrUpdater) => {
    const current = bridgeList(bridgesRef.current)
    const next = bridgeList(
      typeof nextOrUpdater === 'function' ? nextOrUpdater(current) : nextOrUpdater,
    )
    if (sameBridgeList(current, next)) return false
    coalesceRef.current = null
    pushPast({ kind: 'bridges', snapshot: current })
    bridgesRef.current = next
    patch({ manualBridges: next })
    return true
  }, [patch, pushPast])

  /**
   * Commits the result of a finished pointer gesture (move, node drag,
   * erase stroke) as exactly one undo step. `base` is the list the gesture
   * started from; if something else committed in the meantime (a re-trace,
   * an undo) the stale result is dropped rather than overwriting it.
   */
  const commitGestureEntities = useCallback((next, base) => {
    if (!next || next === base) return false
    if (base && entitiesRef.current !== base) return false
    coalesceRef.current = null
    if (!commitEntities(next)) return false
    retainLiveSelection(setSelectedEntityIds, next)
    return true
  }, [commitEntities])

  const undo = useCallback(() => {
    const stack = pastRef.current
    if (!stack.length) return false
    coalesceRef.current = null
    const previous = stack[stack.length - 1]
    const nextPast = stack.slice(0, -1)
    const nextFuture = pushLimited(futureRef.current, stepAside(previous, entitiesRef, bridgesRef), HISTORY_LIMIT)
    pastRef.current = nextPast
    futureRef.current = nextFuture
    setPast(nextPast)
    setFuture(nextFuture)
    applyEntry(previous)
    return true
  }, [applyEntry])

  const redo = useCallback(() => {
    const stack = futureRef.current
    if (!stack.length) return false
    coalesceRef.current = null
    const restored = stack[stack.length - 1]
    const nextFuture = stack.slice(0, -1)
    const nextPast = pushLimited(pastRef.current, stepAside(restored, entitiesRef, bridgesRef), HISTORY_LIMIT)
    pastRef.current = nextPast
    futureRef.current = nextFuture
    setPast(nextPast)
    setFuture(nextFuture)
    applyEntry(restored)
    return true
  }, [applyEntry])

  const commitEntity = useCallback((partial) => {
    const points = (partial?.points || [])
      .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    if (points.length < 2) return null
    const entity = {
      id: uid(),
      type: partial.type || 'path',
      points,
      closed: Boolean(partial.closed),
      baked: Boolean(partial.baked),
      strokeWidth: clampStrokeMm(partial.strokeWidth ?? panelStrokeRef.current),
      lineStyle: normalizeLineStyle(partial.lineStyle ?? panelStyleRef.current),
    }
    commitEntities([...entitiesRef.current, entity])
    setSelectedEntityIds([entity.id])
    return entity.id
  }, [commitEntities])

  const replaceEntityPoints = useCallback((id, points) => {
    const prev = entitiesRef.current
    let changed = false
    const next = prev.map((entity) => {
      if (entity.id !== id) return entity
      changed = true
      return {
        ...entity,
        points: points.map((p) => ({ x: p.x, y: p.y })),
      }
    })
    if (!changed) return
    commitEntities(next)
  }, [commitEntities])

  /**
   * Resizes `id` so its bounding box becomes `widthMm` x `heightMm`, scaling
   * about the box centre. A `groupId` brings the rest of that group. When
   * `id` is part of the current selection, the whole selection scales as one
   * body, matching the combined box drawn on the canvas. Stroke thickness
   * stays an absolute millimetre value.
   */
  const scaleEntity = useCallback((id, widthMm, heightMm) => {
    const scale = mmPerUnitRef.current
    if (!scale || !id) return
    const prev = entitiesRef.current
    const selected = selectedRef.current
    const ids = selected.includes(id)
      ? expandSelectionIds(prev, selected)
      : entityGroupIds(prev, id)
    if (!ids.length) return
    const valid = (mm) => Number.isFinite(mm) && mm >= MIN_DIMENSION_MM && mm <= MAX_DIMENSION_MM
    const next = scaleEntitiesToSize(
      prev,
      ids,
      valid(widthMm) ? widthMm / scale.x : NaN,
      valid(heightMm) ? heightMm / scale.y : NaN,
    )
    if (next === prev) return
    commitEntities(next, `scale:${id}`)
  }, [commitEntities])

  const deleteSelected = useCallback(() => {
    const drop = new Set(selectedRef.current)
    if (drop.size === 0) return
    const next = entitiesRef.current.filter((entity) => !drop.has(entity.id))
    if (next.length === entitiesRef.current.length) return
    commitEntities(next)
    setSelectedEntityIds([])
  }, [commitEntities])

  const copySelected = useCallback(() => {
    const selected = new Set(selectedRef.current)
    if (!selected.size) return false
    const picked = []
    for (const entity of entitiesRef.current) {
      if (selected.has(entity.id)) picked.push(entity)
    }
    const copies = cloneEntityList(picked, 0, 0, false)
    if (!copies.length) return false
    clipboardRef.current = copies
    setClipboard(copies)
    return true
  }, [])

  /**
   * Inserts a fresh copy of the clipboard, shifted by 5 mm, as one undo step.
   * The clipboard then becomes that copy, so the next paste steps another 5 mm.
   */
  const paste = useCallback(() => {
    const source = clipboardRef.current
    if (!source?.length) return false
    const { x: dx, y: dy } = pasteDelta(mmPerUnitRef.current)
    const clones = cloneEntityList(source, dx, dy, true)
    if (!clones.length) return false
    if (!commitEntities(entitiesRef.current.concat(clones))) return false
    const stored = cloneEntityList(clones, 0, 0, false)
    clipboardRef.current = stored
    setClipboard(stored)
    setSelectedEntityIds(clones.map((entity) => entity.id))
    return true
  }, [commitEntities])

  /** One new `groupId` on the selection, so later clicks move and scale them together. */
  const groupSelected = useCallback(() => {
    const prev = entitiesRef.current
    const pickedList = expandSelectionIds(prev, selectedRef.current)
    if (pickedList.length < 2) return false
    const picked = new Set(pickedList)
    let shared
    let uniform = true
    for (const entity of prev) {
      if (!picked.has(entity.id)) continue
      const key = entity.groupId || null
      if (shared === undefined) shared = key
      else if (key !== shared) uniform = false
    }
    if (uniform && shared) return false
    const groupId = uid()
    const next = prev.map((entity) => (picked.has(entity.id) ? { ...entity, groupId } : entity))
    if (!commitEntities(next)) return false
    setSelectedEntityIds(pickedList)
    return true
  }, [commitEntities])

  const ungroupSelected = useCallback(() => {
    const prev = entitiesRef.current
    const pickedList = expandSelectionIds(prev, selectedRef.current)
    if (!pickedList.length) return false
    const picked = new Set(pickedList)
    let changed = false
    const next = prev.map((entity) => {
      if (!picked.has(entity.id) || !entity.groupId) return entity
      changed = true
      const rest = { ...entity }
      delete rest.groupId
      return rest
    })
    if (!changed) return false
    if (!commitEntities(next)) return false
    setSelectedEntityIds(pickedList)
    return true
  }, [commitEntities])

  const setStrokeWidth = useCallback((mm) => {
    const width = clampStrokeMm(mm)
    setDefaultStrokeWidth(width)
    panelStrokeRef.current = width
    const ids = selectedRef.current
    if (!ids.length) return
    const selected = new Set(ids)
    const prev = entitiesRef.current
    let changed = false
    const next = prev.map((entity) => {
      if (!selected.has(entity.id) || entity.strokeWidth === width) return entity
      changed = true
      return { ...entity, strokeWidth: width }
    })
    if (!changed) return
    commitEntities(next, 'stroke')
  }, [commitEntities])

  const setLineStyle = useCallback((style) => {
    const lineStyle = normalizeLineStyle(style)
    setDefaultLineStyle(lineStyle)
    panelStyleRef.current = lineStyle
    const ids = selectedRef.current
    if (!ids.length) return
    const selected = new Set(ids)
    const prev = entitiesRef.current
    let changed = false
    const next = prev.map((entity) => {
      if (!selected.has(entity.id) || normalizeLineStyle(entity.lineStyle) === lineStyle) return entity
      changed = true
      return { ...entity, lineStyle }
    })
    if (!changed) return
    commitEntities(next)
  }, [commitEntities])

  const setEraserSize = useCallback((mm) => {
    setEraserSizeMm(clampEraserMm(mm))
  }, [])

  // Until the silhouette is touched the cutter keeps fitting `rawPaths`
  // directly, exactly as before. Once any region moves, bends, shrinks, grows
  // or disappears, the edited regions become the cavity.
  const baseDirty = useMemo(() => {
    if (!baseSeed.entities.length) return false
    return !isBasePristine(
      entities.filter((entity) => entity.base),
      baseSeed.entities,
    )
  }, [entities, baseSeed])
  const camReplaceBase = editable && baseDirty

  const camStrokes = useMemo(() => {
    if (!editable) return EMPTY_STROKES
    const source = baseDirty ? entities : entities.filter((entity) => !entity.base)
    const strokes = editorEntitiesToTraceStrokes(source)
    return strokes.length ? strokes : EMPTY_STROKES
  }, [entities, editable, baseDirty])

  const strokeWidthMm = useMemo(() => {
    if (!selectedEntityIds.length) return defaultStrokeWidth
    const selected = entities.find((entity) => entity.id === selectedEntityIds[0])
    return selected?.strokeWidth ?? defaultStrokeWidth
  }, [entities, selectedEntityIds, defaultStrokeWidth])

  const lineStyle = useMemo(() => {
    if (!selectedEntityIds.length) return defaultLineStyle
    const selected = entities.find((entity) => entity.id === selectedEntityIds[0])
    return normalizeLineStyle(selected?.lineStyle ?? defaultLineStyle)
  }, [entities, selectedEntityIds, defaultLineStyle])

  useLayoutEffect(() => {
    panelStrokeRef.current = strokeWidthMm
    panelStyleRef.current = lineStyle
  }, [strokeWidthMm, lineStyle])

  useEffect(() => {
    if (view !== 'editor' || settings.thingToMake === 'stencil') return undefined

    const onKeyDown = (event) => {
      const meta = event.ctrlKey || event.metaKey
      if (!meta || event.altKey || event.repeat) return
      if (isTextEntryTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'c' && !event.shiftKey) {
        if (!selectedRef.current.length) return
        event.preventDefault()
        copySelected()
        return
      }
      if (key === 'g') {
        event.preventDefault()
        if (event.shiftKey) ungroupSelected()
        else groupSelected()
      }
    }

    // Capture on window, so a focused toolbar button still receives the
    // shortcut. The paste *event* is used for Ctrl+V: preventDefault on the
    // key would swallow an image or SVG before the importer can read it.
    const onPaste = (event) => {
      if (isTextEntryTarget(event.target)) return
      if (clipboardCarriesImage(event.clipboardData)) return
      if (!clipboardRef.current?.length) return
      event.preventDefault()
      event.stopPropagation()
      paste()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('paste', onPaste, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('paste', onPaste, true)
    }
  }, [view, settings.thingToMake, copySelected, paste, groupSelected, ungroupSelected])

  const canUndo = past.length > 0
  const canRedo = future.length > 0
  const canPaste = Boolean(clipboard?.length)

  const value = useMemo(
    () => ({
      entities,
      activeTool,
      setActiveTool,
      selectedEntityIds,
      selectOnly,
      toggleSelected,
      clearSelection,
      defaultStrokeWidth,
      strokeWidthMm,
      setStrokeWidth,
      defaultLineStyle,
      lineStyle,
      setLineStyle,
      eraserSizeMm,
      setEraserSize,
      canvasTransform,
      setCanvasTransform,
      commitEntity,
      commitGestureEntities,
      commitManualBridges,
      replaceEntityPoints,
      scaleEntity,
      mmPerUnit,
      deleteSelected,
      copySelected,
      paste,
      canPaste,
      groupSelected,
      ungroupSelected,
      undo,
      redo,
      canUndo,
      canRedo,
    }),
    [
      entities,
      activeTool,
      setActiveTool,
      selectedEntityIds,
      selectOnly,
      toggleSelected,
      clearSelection,
      defaultStrokeWidth,
      strokeWidthMm,
      setStrokeWidth,
      defaultLineStyle,
      lineStyle,
      setLineStyle,
      eraserSizeMm,
      setEraserSize,
      canvasTransform,
      setCanvasTransform,
      commitEntity,
      commitGestureEntities,
      commitManualBridges,
      replaceEntityPoints,
      scaleEntity,
      mmPerUnit,
      deleteSelected,
      copySelected,
      paste,
      canPaste,
      groupSelected,
      ungroupSelected,
      undo,
      redo,
      canUndo,
      canRedo,
    ],
  )

  const cam = useMemo(() => ({ camStrokes, camReplaceBase }), [camStrokes, camReplaceBase])

  return (
    <VectorEditorContext.Provider value={value}>
      <VectorCamContext.Provider value={cam}>{children}</VectorCamContext.Provider>
    </VectorEditorContext.Provider>
  )
}
