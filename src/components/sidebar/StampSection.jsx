import { useSettings } from '../../context/useSettings.js'
import { FieldHelp, NumberField } from '../ui/NumberField.jsx'
import { Select } from '../ui/Select.jsx'
import { Toggle } from '../ui/Toggle.jsx'
import { Accordion } from './Accordion.jsx'

/**
 * The ONLY feature section shown for `thingToMake === 'stamp'` (besides
 * the always-visible Profile/Size sections — see `Sidebar.jsx`). Binds
 * to the knobs `buildStampGeometry`/`generateFullCutterModel` (in
 * `lib/cutterGeometry.js`) read: backing-plate thickness, how far the
 * raised imprint details stand up off the plate, a signed imprint
 * thickness (positive values dilate the fill and the plate by the same
 * Round offset; the cutter cavity grows to keep the clearance), and — in
 * `cutterStamp` mode only — the tolerance gap added on top of that growth.
 * Standalone "Stamp" has no cutter to expand, so clearance is a no-op
 * there. A negative thickness erodes the imprint only. Delete outer edge
 * drops a drawn bounding frame. Style embosses the imprint off the plate
 * or debosses it into an engraved cavity. An imported stamp SVG replaces
 * the silhouette fill; the plate outline stays the cutter shape. Base
 * offset grows the backing plate, and Cutter & Stamp grows the blade to
 * wrap it.
 */
export function StampSection({ open, onToggle }) {
  const { settings, patch, loadStampArtwork, clearStampArtwork } = useSettings()
  const stampStyle = settings.stampStyle === 'deboss' || settings.invertStamp ? 'deboss' : 'emboss'
  const artworkName = settings.stampArtworkName || ''
  const hasArtwork = Array.isArray(settings.stampArtworkPaths) && settings.stampArtworkPaths.length > 0

  return (
    <Accordion title="Stamp" open={open} onToggle={onToggle}>
      <div className="flex flex-col gap-2">
        <NumberField
          label="Back thickness (mm)"
          value={settings.stampBackThickness}
          onChange={(stampBackThickness) => patch({ stampBackThickness })}
          step={0.1}
          min={0.4}
          tooltip="Thickness of the flat backing plate. The plate sits flush on the build plate, and the imprint stands up from its top face."
        />
        <NumberField
          label="Stamp clearance / tolerance (mm)"
          value={settings.stampClearance}
          onChange={(stampClearance) => patch({ stampClearance })}
          step={0.1}
          min={0}
          tooltip="Extra gap between the stamp and the cutter wall in Cutter & Stamp. The blade cavity grows by this amount so the stamp fits loosely inside. Standalone Stamp does not use it."
        />
        <NumberField
          label="Imprint depth (mm)"
          value={settings.stampImprintDepth}
          onChange={(stampImprintDepth) => patch({ stampImprintDepth })}
          step={0.1}
          min={0.2}
          tooltip="Emboss: how far the design stands up off the backing plate. Deboss: how deep the engraved cavity is. The plate under the cavity stays as the floor."
        />
        <NumberField
          label="Imprint thickness (mm)"
          value={settings.stampImprintThickness ?? 0}
          onChange={(stampImprintThickness) => patch({ stampImprintThickness })}
          step={0.05}
          tooltip="Make the imprint thicker or thinner. Positive values thicken the silhouette imprint and grow the outer border by the same amount. Cutter & Stamp expands the cavity to match. Deboss, and an imported stamp SVG, thicken the design only — the plate stays put."
        />
        <NumberField
          label="Base offset (mm)"
          value={settings.stampBaseOffset ?? 0}
          onChange={(stampBaseOffset) => patch({ stampBaseOffset })}
          step={0.1}
          min={0}
          tooltip="Grows only the backing plate. The imprint keeps its size. Cutter & Stamp expands the blade so it still wraps the larger plate."
        />
        <div className="flex items-center gap-2">
          <span className="text-[13px]">Delete outer edge</span>
          <FieldHelp text="Drops the largest outline, such as a drawn bounding box, and uses the shapes inside it as the stamp." />
          <Toggle
            checked={Boolean(settings.deleteOuterEdge)}
            onChange={(deleteOuterEdge) => patch({ deleteOuterEdge })}
          />
        </div>
        <Select
          label="Style"
          value={stampStyle}
          onChange={(next) => patch({ stampStyle: next, invertStamp: next === 'deboss' })}
          options={[
            { value: 'emboss', label: 'Emboss (Raised)' },
            { value: 'deboss', label: 'Deboss (Engraved)' },
          ]}
        />
        <label className="flex h-8 cursor-pointer items-center justify-center rounded-[4px] border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[13px] text-[var(--text-primary)] hover:border-[var(--accent)]">
          Import Stamp Design (SVG)
          <input
            type="file"
            accept=".svg,image/svg+xml"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) loadStampArtwork(file)
            }}
          />
        </label>
        {hasArtwork ? (
          <>
            <NumberField
              label="Artwork margin (mm)"
              value={settings.stampArtworkMargin ?? 2}
              onChange={(stampArtworkMargin) => patch({ stampArtworkMargin })}
              step={0.1}
              min={0}
            />
            <div className="flex items-center justify-between gap-2 text-[12px] text-[var(--text-secondary)]">
              <span className="min-w-0 truncate" title={artworkName || 'Stamp design'}>
                {artworkName || 'Stamp design'}
              </span>
              <button type="button" onClick={clearStampArtwork} className="shrink-0 text-[var(--accent)]">
                Remove
              </button>
            </div>
          </>
        ) : (
          <p className="text-[12px] leading-snug text-[var(--text-muted)]">
            Without an SVG, the stamp uses the cutter silhouette. An imported design replaces that fill.
          </p>
        )}
      </div>
    </Accordion>
  )
}
