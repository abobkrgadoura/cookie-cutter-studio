import { Info, Trash2 } from 'lucide-react'
import { useSettings } from '../../context/useSettings.js'
import { Checkbox } from '../ui/Checkbox.jsx'
import { NumberField } from '../ui/NumberField.jsx'
import { Toggle } from '../ui/Toggle.jsx'
import { Accordion } from './Accordion.jsx'

function newBar() {
  return { id: crypto.randomUUID?.() ?? String(Date.now()), angle: 0, position: 50, width: 8, height: 10 }
}

export function CenterBars({ open, onToggle }) {
  const { settings, patch } = useSettings()

  const updateBar = (id, key, value) => {
    patch((s) => ({
      ...s,
      centerBars: s.centerBars.map((b) => (b.id === id ? { ...b, [key]: value } : b)),
    }))
  }

  return (
    <Accordion title="Center Bars" open={open} onToggle={onToggle}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px]">Enable</span>
        <Toggle
          checked={settings.centerBarsEnabled}
          onChange={(centerBarsEnabled) => patch({ centerBarsEnabled })}
        />
      </div>

      {settings.centerBarsEnabled && (
        <>
          {settings.centerBars.map((bar) => (
            <div key={bar.id} className="mb-3 flex items-center gap-2">
              <div className="min-w-0 flex-1 space-y-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg-card)] p-2">
                <NumberField
                  label="Angle (°)"
                  value={bar.angle}
                  onChange={(v) => updateBar(bar.id, 'angle', v)}
                  step={1}
                />
                <NumberField
                  label="Position (%)"
                  value={bar.position}
                  onChange={(v) => updateBar(bar.id, 'position', v)}
                  step={1}
                  min={0}
                  max={100}
                />
                <NumberField
                  label="Width (mm)"
                  value={bar.width}
                  onChange={(v) => updateBar(bar.id, 'width', v)}
                  step={0.1}
                  min={0.5}
                />
                <NumberField
                  label="Height (mm)"
                  value={bar.height ?? 10}
                  onChange={(v) => updateBar(bar.id, 'height', v)}
                  step={0.5}
                  min={0.5}
                />
              </div>
              <button
                type="button"
                className="text-[var(--text-muted)] hover:text-[var(--text-danger)]"
                onClick={() =>
                  patch((s) => ({
                    ...s,
                    centerBars: s.centerBars.filter((b) => b.id !== bar.id),
                  }))
                }
                aria-label="Delete bar"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}

          <button
            type="button"
            className="mb-3 w-full text-center text-[12px] font-medium tracking-wide text-[var(--text-secondary)]"
            onClick={() =>
              patch((s) => ({
                ...s,
                centerBars: [...s.centerBars, newBar()],
              }))
            }
          >
            + ADD BAR
          </button>
        </>
      )}

      <Checkbox
        checked={settings.centerBarsForceSolid}
        onChange={(centerBarsForceSolid) => patch({ centerBarsForceSolid })}
        label="Force solid"
      >
        <span title="Fills the bar so it prints as a solid rib instead of a hollow channel.">
          <Info size={13} className="text-[var(--text-muted)]" />
        </span>
      </Checkbox>
    </Accordion>
  )
}
