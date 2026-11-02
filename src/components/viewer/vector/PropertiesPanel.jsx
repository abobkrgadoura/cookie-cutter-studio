import { useMemo, useState } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import { NumberField } from '../../ui/NumberField.jsx'
import { Select } from '../../ui/Select.jsx'
import { useSettings } from '../../../context/useSettings.js'
import { useVectorEditor } from '../../../context/useVectorEditor.js'
import {
  DASH_CUT_MM,
  DASH_GAP_MM,
  MAX_ERASER_MM,
  MAX_STROKE_MM,
  MIN_ERASER_MM,
  MIN_STROKE_MM,
  entitiesBounds,
} from '../../../lib/vectorEntities.js'
import { fromDisplay, toDisplay, unitLabel } from '../../../lib/units.js'

const LINE_STYLE_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'filled', label: 'Filled' },
]

/** Two displayed values closer than this (mm) are the same size. */
const SAME_MM = 1e-6

/**
 * A size field that tolerates half-typed numbers. NumberField is controlled,
 * so a value the editor rejects ("0", "0.05") would be reverted under the
 * caret and "0.5" could never be typed. The typed number is kept as a draft
 * for as long as it still describes the shape, or the shape has not changed
 * since it was typed. Anything else (a drag, a node edit, another selection
 * through `key`) drops the draft and shows the true size. Leaving the field
 * also drops it.
 */
function DimensionField({ label, valueMm, unit, tooltip, onCommit }) {
  const [draft, setDraft] = useState(null)
  const step = unit === 'inch' ? 0.01 : 0.1

  let shown = toDisplay(valueMm, unit)
  if (draft) {
    const typedMm = fromDisplay(draft.text, unit)
    const matchesShape = Math.abs(valueMm - typedMm) < SAME_MM
    const shapeUntouched = Math.abs(valueMm - draft.atMm) < SAME_MM
    if (matchesShape || shapeUntouched) shown = draft.text
  }

  return (
    <div onBlur={() => setDraft(null)}>
      <NumberField
        label={label}
        unit={unitLabel(unit)}
        value={shown}
        min={toDisplay(0.1, unit)}
        step={step}
        tooltip={tooltip}
        onChange={(next) => {
          setDraft({ text: next, atMm: valueMm })
          const mm = fromDisplay(next, unit)
          if (Number.isFinite(mm) && mm > 0) onCommit(mm)
        }}
      />
    </div>
  )
}

const historyButtonClass =
  'rounded p-1.5 text-[var(--text-primary)] hover:bg-[var(--bg-input-hover)] disabled:cursor-not-allowed disabled:opacity-30'

/**
 * Header arrows for the properties column. Canvas edits come from the vector
 * history. Contrast and invert keep their own stack and run only when the
 * canvas has no step in that direction.
 */
export function VectorHistoryButtons({
  fallbackUndo,
  fallbackRedo,
  fallbackCanUndo = false,
  fallbackCanRedo = false,
}) {
  const { undo: undoEntities, redo: redoEntities, canUndo: canUndoEntities, canRedo: canRedoEntities } =
    useVectorEditor()
  const canUndo = canUndoEntities || fallbackCanUndo
  const canRedo = canRedoEntities || fallbackCanRedo
  const undo = () => {
    if (!undoEntities()) fallbackUndo?.()
  }
  const redo = () => {
    if (!redoEntities()) fallbackRedo?.()
  }

  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={undo}
        disabled={!canUndo}
        aria-label="Undo"
        title="Undo"
        className={historyButtonClass}
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={!canRedo}
        aria-label="Redo"
        title="Redo"
        className={historyButtonClass}
      >
        <Redo2 size={16} />
      </button>
    </div>
  )
}

export function PropertiesPanel() {
  const { settings, image } = useSettings()
  const {
    entities,
    activeTool,
    selectedEntityIds,
    strokeWidthMm,
    setStrokeWidth,
    lineStyle,
    setLineStyle,
    eraserSizeMm,
    setEraserSize,
    scaleEntity,
    mmPerUnit,
  } = useVectorEditor()
  const unit = settings.unit === 'inch' ? 'inch' : 'mm'
  const editingSelection = selectedEntityIds.length > 0
  const raster = (Boolean(image?.source) && !image?.isSvg) || Boolean(image?.preset)
  const selectedId = selectedEntityIds[0] ?? null
  const hasBaseSelected = useMemo(
    () => entities.some((entity) => entity.base && selectedEntityIds.includes(entity.id)),
    [entities, selectedEntityIds],
  )

  // Bounding box of the selection (the whole silhouette when it is made of
  // several islands), in millimetres. Editor units convert with the fit of
  // the original trace, the same scale the cutter is built with.
  const sizeMm = useMemo(() => {
    if (!editingSelection || !mmPerUnit) return null
    const bounds = entitiesBounds(entities, selectedEntityIds)
    if (!bounds) return null
    return { width: bounds.width * mmPerUnit.x, height: bounds.height * mmPerUnit.y }
  }, [editingSelection, entities, selectedEntityIds, mmPerUnit])

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 border-b border-[var(--border)] pb-4">
      {sizeMm && selectedId && (
        <>
          <DimensionField
            key={`w:${selectedId}:${unit}`}
            label="Width"
            valueMm={sizeMm.width}
            unit={unit}
            tooltip="Exact width of the selection's bounding box. Typing scales it about its centre. Measured along the shape outline, not the stroke band."
            onCommit={(mm) => scaleEntity(selectedId, mm, sizeMm.height)}
          />
          <DimensionField
            key={`h:${selectedId}:${unit}`}
            label="Height"
            valueMm={sizeMm.height}
            unit={unit}
            tooltip="Exact height of the selection's bounding box. Typing scales it about its centre. Measured along the shape outline, not the stroke band."
            onCommit={(mm) => scaleEntity(selectedId, sizeMm.width, mm)}
          />
          <p className="text-[11px] text-[var(--text-muted)]">
            {hasBaseSelected
              ? 'Traced silhouette. Move, erase or node-edit it like any shape. Resizing it changes the cavity in millimetres; the sidebar size still refers to the original trace.'
              : 'Width and height are in millimetres on the printed cutter.'}
          </p>
        </>
      )}
      <NumberField
        label="Stroke Thickness"
        unit={unitLabel(unit)}
        value={toDisplay(strokeWidthMm, unit)}
        min={toDisplay(MIN_STROKE_MM, unit)}
        max={toDisplay(MAX_STROKE_MM, unit)}
        step={unit === 'inch' ? 0.01 : 0.1}
        tooltip="Half of this width is offset on each side of the centerline with round joins and round caps. The filled band is unioned with the traced silhouette. The trace itself is not refit."
        onChange={(value) => setStrokeWidth(fromDisplay(value, unit))}
      />
      <Select
        label="Line Style"
        value={lineStyle}
        options={LINE_STYLE_OPTIONS}
        onChange={setLineStyle}
      />
      <p className="text-[11px] text-[var(--text-muted)]">
        Dashed strokes cut {DASH_CUT_MM} mm, then skip {DASH_GAP_MM} mm, along the centerline. Filled
        shapes are solid inside and ignore stroke thickness.
      </p>
      <NumberField
        label="Eraser Size"
        unit={unitLabel(unit)}
        value={toDisplay(eraserSizeMm, unit)}
        min={toDisplay(MIN_ERASER_MM, unit)}
        max={toDisplay(MAX_ERASER_MM, unit)}
        step={unit === 'inch' ? 0.01 : 0.1}
        tooltip="Radius of the vector eraser. Each stamp subtracts a circle from the stroked paths."
        onChange={(value) => setEraserSize(fromDisplay(value, unit))}
      />
      <p className="text-[11px] text-[var(--text-muted)]">
        {editingSelection
          ? `Editing ${selectedEntityIds.length} selected shape${selectedEntityIds.length === 1 ? '' : 's'}.`
          : 'Sets the thickness and style of the next stroke.'}
        {entities.length > 0 ? ` ${entities.length} on canvas.` : ''}
        {activeTool === 'node' ? ' Drag a handle to move that vertex.' : ''}
      </p>
      <p className="text-[11px] text-[var(--text-muted)]">
        {raster
          ? 'Drawn strokes are merged into the cutter after the silhouette is fitted, so this thickness stays in millimetres.'
          : 'Stroke merge runs on raster traces and library presets. An imported SVG keeps its own geometry.'}
      </p>
    </div>
  )
}
