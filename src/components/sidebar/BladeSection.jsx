import { useSettings } from '../../context/useSettings.js'
import { NumberField } from '../ui/NumberField.jsx'
import { Accordion } from './Accordion.jsx'

export function BladeSection({ open, onToggle }) {
  const { settings, patch } = useSettings()

  return (
    <Accordion title="Blade" open={open} onToggle={onToggle}>
      <div className="flex min-w-0 flex-col gap-2">
        <NumberField
          label="Depth (mm)"
          value={settings.bladeDepth}
          onChange={(bladeDepth) => patch({ bladeDepth })}
          step={0.1}
          min={0.5}
        />
        <NumberField
          label="Thickness (mm)"
          value={settings.bladeThickness}
          onChange={(bladeThickness) => patch({ bladeThickness })}
          step={0.05}
          min={0.2}
        />
      </div>
    </Accordion>
  )
}
