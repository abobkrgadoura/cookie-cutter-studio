import { useSettings } from '../../context/useSettings.js'
import { LIGHTBOX_BATTERY_OPTIONS, defaultLightboxExportParts } from '../../lib/presets.js'
import { fromDisplay, toDisplay } from '../../lib/units.js'
import { Checkbox } from '../ui/Checkbox.jsx'
import { FieldHelp } from '../ui/NumberField.jsx'
import { Select } from '../ui/Select.jsx'
import { Accordion } from './Accordion.jsx'

const EXPORT_PARTS = [
  { key: 'walls', label: '4 walls' },
  { key: 'base', label: 'Base' },
  { key: 'pillar', label: 'LED pillar' },
  { key: 'imagePlate', label: 'Image plate' },
]

function MmSlider({ label, mm, min, max, step, onChange, unit, tooltip }) {
  const display = toDisplay(mm, unit)
  const dMin = toDisplay(min, unit)
  const dMax = toDisplay(max, unit)
  const dStep = unit === 'inch' ? 0.005 : step
  const pct = Math.min(100, Math.max(0, ((mm - min) / (max - min)) * 100))
  const unitText = unit === 'inch' ? 'in' : 'mm'
  const shown = unit === 'inch' ? display.toFixed(3) : Number(mm).toFixed(2)

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="truncate">{label}</span>
          <FieldHelp text={tooltip} />
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-secondary)]">
          {shown} {unitText}
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
          const next = fromDisplay(Number(e.target.value), unit)
          const clamped = Math.min(max, Math.max(min, next))
          onChange(Math.round(clamped * 100) / 100)
        }}
        className="h-2 w-full cursor-pointer"
        style={{ '--range-pct': `${pct}%` }}
      />
    </div>
  )
}

/**
 * Shown only for `thingToMake === 'lightbox'`. Stores box size, wall
 * thickness, battery pocket, and which solids the preview and a download
 * include.
 */
export function LightboxSection({ open, onToggle }) {
  const { settings, patch } = useSettings()
  const unit = settings.unit
  const parts = { ...defaultLightboxExportParts(), ...settings.exportParts }

  const setPart = (key, checked) => {
    patch({ exportParts: { ...parts, [key]: checked } })
  }

  return (
    <Accordion title="Shadow Lightbox" open={open} onToggle={onToggle}>
      <div className="flex min-w-0 flex-col gap-3">
        <MmSlider
          label="Width"
          mm={settings.boxWidth ?? 120}
          min={40}
          max={300}
          step={1}
          unit={unit}
          onChange={(boxWidth) => patch({ boxWidth })}
          tooltip="Outer width of the box, in the current unit. The stencil walls sit on this envelope."
        />
        <MmSlider
          label="Height"
          mm={settings.boxHeight ?? 150}
          min={40}
          max={400}
          step={1}
          unit={unit}
          onChange={(boxHeight) => patch({ boxHeight })}
          tooltip="Outer height of the box. This is the tall face the image is projected through."
        />
        <MmSlider
          label="Depth"
          mm={settings.boxDepth ?? 50}
          min={20}
          max={150}
          step={1}
          unit={unit}
          onChange={(boxDepth) => patch({ boxDepth })}
          tooltip="Outer depth from the front wall to the back wall. The LED pillar stands inside this span."
        />
        <MmSlider
          label="Wall thickness"
          mm={settings.wallThickness ?? 2}
          min={0.8}
          max={6}
          step={0.1}
          unit={unit}
          onChange={(wallThickness) => patch({ wallThickness })}
          tooltip="Thickness of each printed wall, the base, and the image plate. Added after the box size."
        />
        <Select
          label="Battery"
          value={settings.batteryType || '2xAAA'}
          onChange={(batteryType) => patch({ batteryType })}
          options={LIGHTBOX_BATTERY_OPTIONS}
        />
        <div className="flex flex-col gap-2 pt-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            Parts to download
          </span>
          {EXPORT_PARTS.map((part) => (
            <Checkbox
              key={part.key}
              label={part.label}
              checked={parts[part.key] !== false}
              onChange={(checked) => setPart(part.key, checked)}
            />
          ))}
        </div>
      </div>
    </Accordion>
  )
}
