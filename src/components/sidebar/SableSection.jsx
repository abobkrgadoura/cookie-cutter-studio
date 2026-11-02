import { useSettings } from '../../context/useSettings.js'
import { NumberField } from '../ui/NumberField.jsx'
import { Select } from '../ui/Select.jsx'
import { Toggle } from '../ui/Toggle.jsx'
import { Accordion } from './Accordion.jsx'

const BRIDGE_TYPES = [
  { value: 'cross', label: 'Cross' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'flared', label: 'V-Shape' },
  { value: 'cross_flared', label: 'Cross V-Shape' },
]

/**
 * Shown only for `thingToMake === 'sable'`. Binds the knobs
 * `buildSableGeometry` reads: a full-height outer wall, a window wall
 * that is sharp only at the top, the bridges that tie them together,
 * line-drawing auto-fill, the optional patterned stamp plate, and the
 * bridges. Pattern thickness offsets only the stamp paths. The walls stay
 * on the trace. Bridges can stay on with the stamp so a thinned pattern
 * remains tied to the walls.
 */
export function SableSection({ open, onToggle }) {
  const { settings, patch } = useSettings()
  const stampMode = Boolean(settings.sableStampMode)
  const bridgesEnabled = settings.sableBridgesEnabled ?? true

  return (
    <Accordion title="Sablé / Linzer" open={open} onToggle={onToggle}>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[13px] leading-snug">Auto-Fill Line Drawing (Plain Dough)</span>
          <Toggle
            checked={Boolean(settings.sableLineDrawingMode)}
            onChange={(sableLineDrawingMode) => patch({ sableLineDrawingMode })}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[13px] leading-snug">Enable Sablé Stamp (Patterned)</span>
          <Toggle
            checked={stampMode}
            onChange={(sableStampMode) => patch({ sableStampMode })}
          />
        </div>
        {stampMode && (
          <NumberField
            label="Stamp height (mm)"
            value={settings.sableStampHeight ?? 3}
            onChange={(sableStampHeight) => patch({ sableStampHeight })}
            step={0.1}
            min={0.5}
            tooltip="Height of the patterned plate. It starts at mid-height. Bridges can stay on and tie a thinned pattern to the walls."
          />
        )}
        {stampMode && (
          <NumberField
            label="Pattern thickness (mm)"
            value={settings.sablePatternThickness ?? 0}
            onChange={(sablePatternThickness) => patch({ sablePatternThickness })}
            step={0.1}
            tooltip="Round offset of the stamp paths only. Positive thickens the pattern. Negative thins it. The walls stay on the traced outline. The plate is clipped to the dough: inside the outer wall, outside the window."
          />
        )}
        <NumberField
          label="Depth (mm)"
          value={settings.sableDepth}
          onChange={(sableDepth) => patch({ sableDepth })}
          step={0.1}
          min={2}
          tooltip="Overall height. The outer wall is sharp at both ends. Each window cutter is sharp only at the top and flat where it meets the bridge."
        />
        <NumberField
          label="Wall thickness (mm)"
          value={settings.sableThickness}
          onChange={(sableThickness) => patch({ sableThickness })}
          step={0.05}
          min={0.3}
          tooltip="Full thickness of the outer wall and of every window cutter."
        />
        <NumberField
          label="Tip width (mm)"
          value={settings.sableTipWidth}
          onChange={(sableTipWidth) => patch({ sableTipWidth })}
          step={0.05}
          min={0.1}
          tooltip="Thickness of each sharp lip. The traced edge stays the vertical cutting face."
        />
        <NumberField
          label="Chamfer (mm)"
          value={settings.sableChamfer}
          onChange={(sableChamfer) => patch({ sableChamfer })}
          step={0.1}
          min={0}
          tooltip="Length of the slope from each sharp lip to full wall thickness. Window cutters slope only at the top."
        />
        <NumberField
          label="Inner hole (mm)"
          value={settings.sableInnerHole}
          onChange={(sableInnerHole) => patch({ sableInnerHole })}
          step={1}
          min={5}
          tooltip="Longest side of the window group, in millimeters. Every window scales together about the group center."
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[13px] leading-snug">Enable Bridges</span>
          <Toggle
            checked={bridgesEnabled}
            onChange={(sableBridgesEnabled) => patch({ sableBridgesEnabled })}
          />
        </div>
        {bridgesEnabled && (
          <Select
            label="Bridge type"
            value={settings.sableBridgeType}
            onChange={(sableBridgeType) => patch({ sableBridgeType })}
            options={BRIDGE_TYPES}
          />
        )}
        {bridgesEnabled && (
          <NumberField
            label="Bridge width (mm)"
            value={settings.sableBridgeWidth}
            onChange={(sableBridgeWidth) => patch({ sableBridgeWidth })}
            step={0.1}
            min={0.1}
            tooltip="Width of the bar that connects the outer wall to each window. The bar stays in the dough and can tie floating stamp pieces to the walls."
          />
        )}
        {bridgesEnabled && (settings.sableBridgeType === 'flared' || settings.sableBridgeType === 'cross_flared') && (
          <NumberField
            label="Bridge flare (mm)"
            value={settings.sableBridgeFlare ?? 15}
            onChange={(sableBridgeFlare) => patch({ sableBridgeFlare })}
            step={1}
            min={0}
            tooltip="Width of the flared bars at the outer edges."
          />
        )}
        {bridgesEnabled && (
          <NumberField
            label="Bridge depth (mm)"
            value={settings.sableBridgeDepth}
            onChange={(sableBridgeDepth) => patch({ sableBridgeDepth })}
            step={0.1}
            min={0.4}
            tooltip="Height of that bar. It starts at mid-height, flush with the flat bottom of each window cutter."
          />
        )}
      </div>
    </Accordion>
  )
}
