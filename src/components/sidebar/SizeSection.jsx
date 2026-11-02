import { Lock, Unlock } from 'lucide-react'
import { useSettings } from '../../context/useSettings.js'
import { fromDisplay, toDisplay } from '../../lib/units.js'
import { NumberField } from '../ui/NumberField.jsx'
import { Select } from '../ui/Select.jsx'
import { Toggle } from '../ui/Toggle.jsx'

export function SizeSection() {
  const {
    settings,
    setUnit,
    setSizeMode,
    setLongestSize,
    setWidth,
    setHeight,
    toggleAspectLock,
    patch,
  } = useSettings()
  const { unit, sizeMode } = settings
  const unitLabel = unit === 'inch' ? 'in' : 'mm'
  const sizeStep = unit === 'inch' ? 0.05 : 0.1

  return (
    <section className="border-b border-[var(--border)] px-4 py-4">
      <div className="mb-3 sidebar-section-title">Size</div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Select
            className="w-[72px] shrink-0"
            value={unit}
            onChange={setUnit}
            options={[
              { value: 'mm', label: 'mm' },
              { value: 'inch', label: 'inch' },
            ]}
          />
          {sizeMode === 'longest' ? (
            <NumberField
              className="min-w-0 flex-1"
              label="Size"
              unit={unitLabel}
              value={toDisplay(settings.size, unit)}
              onChange={(v) => setLongestSize(fromDisplay(v, unit))}
              step={unit === 'inch' ? 0.05 : 0.5}
            />
          ) : (
            <NumberField
              className="min-w-0 flex-1"
              label="Width"
              unit={unitLabel}
              value={toDisplay(settings.width, unit)}
              onChange={(v) => setWidth(fromDisplay(v, unit))}
              step={sizeStep}
            />
          )}
        </div>
        {sizeMode === 'widthHeight' ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleAspectLock}
              className="flex h-8 w-[72px] shrink-0 items-center justify-center rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              title={settings.aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
            >
              {settings.aspectLocked ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
            <NumberField
              className="min-w-0 flex-1"
              label="Height"
              unit={unitLabel}
              value={toDisplay(settings.height, unit)}
              onChange={(v) => setHeight(fromDisplay(v, unit))}
              step={sizeStep}
            />
          </div>
        ) : null}
        <Select
          value={sizeMode}
          onChange={setSizeMode}
          label="Set size of"
          options={[
            { value: 'longest', label: 'Longest Side' },
            { value: 'widthHeight', label: 'Width and Height' },
          ]}
        />
        <div className="flex items-center justify-between gap-2 mt-1">
          <span className="text-[13px]">Mirror design</span>
          <Toggle
            checked={settings.mirrorDesign !== false}
            onChange={(mirrorDesign) => patch({ mirrorDesign })}
          />
        </div>
        <div className="flex items-center justify-between gap-2 mt-1">
          <span className="text-[13px]">Show Dimensions</span>
          <Toggle
            checked={settings.showDimensions !== false}
            onChange={(showDimensions) => patch({ showDimensions })}
          />
        </div>
      </div>
    </section>
  )
}