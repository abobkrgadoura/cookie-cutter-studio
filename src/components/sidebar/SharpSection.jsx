import { useSettings } from '../../context/useSettings.js'
import { NumberField } from '../ui/NumberField.jsx'
import { Toggle } from '../ui/Toggle.jsx'
import { Accordion } from './Accordion.jsx'

export function SharpSection({ open, onToggle }) {
  const { settings, patch } = useSettings()

  return (
    <Accordion title="Sharp" open={open} onToggle={onToggle}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px]">Sharp</span>
        <Toggle
          checked={settings.sharpCutter}
          onChange={(sharpCutter) => patch({ sharpCutter })}
        />
      </div>
      {settings.sharpCutter && (
        <div className="flex min-w-0 flex-col gap-2">
          <NumberField
            label="Tip width (mm)"
            value={settings.cutterChamferWidth}
            onChange={(cutterChamferWidth) => patch({ cutterChamferWidth })}
            step={0.05}
            min={0.1}
          />
          <NumberField
            label="Chamfer height (mm)"
            value={settings.cutterChamferHeight}
            onChange={(cutterChamferHeight) => patch({ cutterChamferHeight })}
            step={0.1}
            min={0}
          />
        </div>
      )}
    </Accordion>
  )
}
