import { useSettings } from '../../context/useSettings.js'
import { NumberField } from '../ui/NumberField.jsx'
import { Select } from '../ui/Select.jsx'
import { Accordion } from './Accordion.jsx'

export function HandleSection({ open, onToggle }) {
  const { settings, patch } = useSettings()

  return (
    <Accordion title="Handle" open={open} onToggle={onToggle}>
      <div className="mb-3 flex min-w-0 flex-col gap-2">
        <NumberField
          label="Height (mm)"
          value={settings.handleHeight}
          onChange={(handleHeight) => patch({ handleHeight })}
          step={0.1}
          min={0}
        />
        <NumberField
          label="Width (mm)"
          value={settings.handleWidth}
          onChange={(handleWidth) => patch({ handleWidth })}
          step={0.1}
          min={0}
        />
      </div>
      <Select
        label="Handle type"
        value={settings.handleShape}
        onChange={(handleShape) => patch({ handleShape })}
        options={[
          { value: 'round', label: 'Round' },
          { value: 'chamfer', label: 'Chamfer' },
          { value: 'rectangular', label: 'Rectangular' },
        ]}
      />
      <p className="help-note mt-3">
        Positive overlap moves the press handles into the cutter; negative values create a gap.
      </p>
    </Accordion>
  )
}
