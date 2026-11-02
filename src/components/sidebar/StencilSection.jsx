import { Lock, Unlock } from 'lucide-react'
import { useModel } from '../../context/useModel.js'
import { useSettings } from '../../context/useSettings.js'
import { useVectorEditor } from '../../context/useVectorEditor.js'
import { fromDisplay, toDisplay } from '../../lib/units.js'
import { FieldHelp, NumberField } from '../ui/NumberField.jsx'
import { Select } from '../ui/Select.jsx'
import { Toggle } from '../ui/Toggle.jsx'
import { Accordion } from './Accordion.jsx'

const ARTWORK_MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'filled', label: 'Filled cutout' },
  { value: 'centerline', label: 'Centerline gap' },
]

const BRIDGE_STRATEGIES = [
  { value: 'shortest', label: 'Shortest gap' },
  { value: 'even', label: 'Evenly spaced' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'manual', label: 'Manual' },
]

function placementValue(settings) {
  if (settings.placement === 'manual' || settings.bridgeStrategy === 'manual') return 'manual'
  return settings.bridgeStrategy || settings.placement || 'shortest'
}

function GroupLabel({ children }) {
  return (
    <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] first:mt-0">
      {children}
    </div>
  )
}

function MmSlider({ label, mm, min, max, step, onChange, unit, tooltip, integer = false }) {
  const display = integer ? mm : toDisplay(mm, unit)
  const dMin = integer ? min : toDisplay(min, unit)
  const dMax = integer ? max : toDisplay(max, unit)
  const dStep = integer ? step : unit === 'inch' ? 0.005 : step
  const pct = Math.min(100, Math.max(0, ((mm - min) / (max - min)) * 100))
  const unitText = integer ? '' : unit === 'inch' ? 'in' : 'mm'
  const shown = integer ? String(Math.round(mm)) : unit === 'inch' ? display.toFixed(3) : Number(mm).toFixed(2)

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="truncate">{label}</span>
          <FieldHelp text={tooltip} />
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-secondary)]">
          {shown}
          {unitText ? ` ${unitText}` : ''}
        </span>
      </div>
      <input
        type="range"
        min={dMin}
        max={dMax}
        step={dStep}
        value={display}
        aria-label={label}
        onChange={(e) => {
          const raw = Number(e.target.value)
          const next = integer ? raw : fromDisplay(raw, unit)
          const clamped = Math.min(max, Math.max(min, next))
          onChange(integer ? Math.round(clamped) : Math.round(clamped * 100) / 100)
        }}
        className="h-2 w-full cursor-pointer"
        style={{ '--range-pct': `${pct}%` }}
      />
    </div>
  )
}

export function StencilSection({ open, onToggle }) {
  const { settings, patch, setUnit } = useSettings()
  const { commitManualBridges } = useVectorEditor()
  const { stencilSheet } = useModel()
  const unit = settings.unit
  const unitLabel = unit === 'inch' ? 'in' : 'mm'
  const step = unit === 'inch' ? 0.05 : 0.5
  const aspect = settings.designAspectRatio || settings.aspectRatio || 1
  const locked = settings.designAspectLocked !== false
  const bridgesOn = settings.stencilBridges !== false
  const placement = placementValue(settings)
  const manualPlacement = placement === 'manual'
  const manualCount = Array.isArray(settings.manualBridges) ? settings.manualBridges.length : 0

  const setDesignWidth = (width) => {
    if (!(width > 0)) return
    if (locked) patch({ designWidth: width, designHeight: width / aspect })
    else patch({ designWidth: width })
  }

  const setDesignHeight = (height) => {
    if (!(height > 0)) return
    if (locked) patch({ designHeight: height, designWidth: height * aspect })
    else patch({ designHeight: height })
  }

  return (
    <Accordion title="Stencil" open={open} onToggle={onToggle}>
      <div className="flex min-w-0 flex-col gap-2">
        <GroupLabel>Sheet</GroupLabel>
        <Select
          label="Units"
          value={unit}
          onChange={setUnit}
          options={[
            { value: 'mm', label: 'mm' },
            { value: 'inch', label: 'inch' },
          ]}
        />
        <NumberField
          label="Board width"
          unit={unitLabel}
          value={toDisplay(settings.stencilBoardWidth ?? 210, unit)}
          onChange={(v) => patch({ stencilBoardWidth: fromDisplay(v, unit) })}
          step={step}
          min={unit === 'inch' ? 1 : 20}
        />
        <NumberField
          label="Board height"
          unit={unitLabel}
          value={toDisplay(settings.stencilBoardHeight ?? 210, unit)}
          onChange={(v) => patch({ stencilBoardHeight: fromDisplay(v, unit) })}
          step={step}
          min={unit === 'inch' ? 1 : 20}
        />
        <NumberField
          label="Margin"
          unit={unitLabel}
          value={toDisplay(settings.stencilMargin ?? 10, unit)}
          onChange={(v) => patch({ stencilMargin: fromDisplay(v, unit) })}
          step={unit === 'inch' ? 0.05 : 0.5}
          min={0}
        />

        <GroupLabel>Artwork</GroupLabel>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              patch({
                designAspectLocked: !locked,
                designAspectRatio: (settings.designWidth || 1) / (settings.designHeight || 1),
              })
            }
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title={locked ? 'Unlock design aspect ratio' : 'Lock design aspect ratio'}
          >
            {locked ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
          <NumberField
            className="min-w-0 flex-1"
            label="Design width"
            unit={unitLabel}
            value={toDisplay(settings.designWidth ?? 80, unit)}
            onChange={(v) => setDesignWidth(fromDisplay(v, unit))}
            step={step}
            min={unit === 'inch' ? 0.2 : 5}
          />
        </div>
        <NumberField
          label="Design height"
          unit={unitLabel}
          value={toDisplay(settings.designHeight ?? 80, unit)}
          onChange={(v) => setDesignHeight(fromDisplay(v, unit))}
          step={step}
          min={unit === 'inch' ? 0.2 : 5}
        />
        <Select
          label="Artwork"
          value={settings.stencilArtwork || 'auto'}
          onChange={(stencilArtwork) => patch({ stencilArtwork })}
          options={ARTWORK_MODES}
        />
        <MmSlider
          label="Cut thickness"
          mm={settings.cutThickness ?? 1.2}
          min={0.2}
          max={8}
          step={0.1}
          unit={unit}
          onChange={(cutThickness) => patch({ cutThickness })}
          tooltip="Width of the slot cut from a single-line SVG. The stroke is outlined so the blade follows both edges of the gap. Filled shapes are cut out as solid regions."
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px]">Mirror design</span>
          <Toggle
            checked={settings.mirrorDesign !== false}
            onChange={(mirrorDesign) => patch({ mirrorDesign })}
          />
        </div>

        <GroupLabel>Repeat</GroupLabel>
        <NumberField
          label="Rows"
          value={settings.rows ?? 1}
          onChange={(rows) => patch({ rows })}
          step={1}
          min={1}
          max={10}
        />
        <NumberField
          label="Columns"
          value={settings.columns ?? 1}
          onChange={(columns) => patch({ columns })}
          step={1}
          min={1}
          max={10}
        />

        <GroupLabel>Bridges</GroupLabel>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 text-[13px] leading-snug">Hold inner islands</span>
          <Toggle checked={bridgesOn} onChange={(stencilBridges) => patch({ stencilBridges })} />
        </div>
        {bridgesOn && (
          <>
            <MmSlider
              label="Bridge width"
              mm={settings.bridgeWidth ?? 1.5}
              min={0.4}
              max={5}
              step={0.1}
              unit={unit}
              onChange={(bridgeWidth) => patch({ bridgeWidth })}
              tooltip="Width of each plastic tab that ties a loose island, such as the center of an O, back to the sheet."
            />
            {!manualPlacement && (
              <MmSlider
                label="Bridges per island"
                mm={settings.bridgeCount ?? 2}
                min={1}
                max={8}
                step={1}
                integer
                unit={unit}
                onChange={(bridgeCount) => patch({ bridgeCount })}
                tooltip="How many tabs are cut into each enclosed island."
              />
            )}
            <Select
              label="Placement"
              value={placement}
              onChange={(next) => patch({ placement: next, bridgeStrategy: next })}
              options={BRIDGE_STRATEGIES}
            />
            {manualPlacement && (
              <>
                <button
                  type="button"
                  onClick={() => commitManualBridges([])}
                  disabled={manualCount === 0}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-input-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Clear Bridges
                </button>
                <p className="text-[12px] leading-snug text-[var(--text-secondary)]">
                  {manualCount > 0
                    ? `${manualCount} bridge${manualCount === 1 ? '' : 's'} placed. `
                    : ''}
                  Open the 2D Editor and drag on the sheet to draw each bridge.
                </p>
              </>
            )}
          </>
        )}

        {stencilSheet?.openIslands > 0 && (
          <p className="text-[12px] leading-snug text-[var(--text-danger)]">
            {stencilSheet.openIslands} island{stencilSheet.openIslands === 1 ? '' : 's'} still fully
            surrounded. Add bridges or widen them so those pieces stay attached.
          </p>
        )}
        {stencilSheet && stencilSheet.sourceIslands > 0 && stencilSheet.openIslands === 0 && bridgesOn && (
          <p className="text-[12px] leading-snug text-[var(--text-secondary)]">
            Inner islands are tied to the sheet.
          </p>
        )}
        {stencilSheet &&
          bridgesOn &&
          stencilSheet.sourceIslands === 0 &&
          stencilSheet.cutPaths?.length > 0 && (
            <p className="text-[12px] leading-snug text-[var(--text-secondary)]">
              This artwork has no enclosed islands. Bridges show up on counters such as the center of an O, or when Artwork is set to Centerline gap.
            </p>
          )}
        {stencilSheet?.scale < 0.995 && (
          <p className="text-[12px] leading-snug text-[var(--text-secondary)]">
            The grid was scaled down so it fits inside the margin.
          </p>
        )}
      </div>
    </Accordion>
  )
}
