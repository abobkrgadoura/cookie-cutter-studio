import { Trash2 } from 'lucide-react'
import { useSettings } from '../../context/useSettings.js'
import { newWallText, WALL_TEXT_FONTS } from '../../lib/constants.js'
import { NumberField, TextAreaField } from '../ui/NumberField.jsx'
import { Select } from '../ui/Select.jsx'
import { Toggle } from '../ui/Toggle.jsx'
import { Accordion, SettingRow } from './Accordion.jsx'

const FONT_OPTIONS = WALL_TEXT_FONTS.map((f) => ({ value: f.value, label: f.value }))

const FONT_WEIGHT_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'bold', label: 'Bold' },
]

export function CutterWallText({ open, onToggle }) {
  const { settings, patch } = useSettings()

  const updateText = (id, key, value) => {
    patch((s) => ({
      ...s,
      wallTexts: s.wallTexts.map((t) => (t.id === id ? { ...t, [key]: value } : t)),
    }))
  }

  return (
    <Accordion
      title={
        <>
          Cutter Wall Text
          <span className="ml-1.5 align-middle text-[10px] font-bold tracking-wide text-amber-600">
            👑 PRO
          </span>
        </>
      }
      open={open}
      onToggle={onToggle}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px]">Enable</span>
        <Toggle checked={settings.wallTextEnabled} onChange={(wallTextEnabled) => patch({ wallTextEnabled })} />
      </div>

      {settings.wallTextEnabled && (
        <>
          {settings.wallTexts.map((item) => (
            <div key={item.id} className="mb-3 flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2 rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg-card)] p-2">
                <SettingRow label="Text" align="start">
                  <TextAreaField value={item.text} onChange={(v) => updateText(item.id, 'text', v)} />
                </SettingRow>
                <Select
                  label="Font"
                  value={item.font}
                  onChange={(v) => updateText(item.id, 'font', v)}
                  options={FONT_OPTIONS}
                />
                <Select
                  label="Weight"
                  value={item.fontWeight ?? 'normal'}
                  onChange={(v) => updateText(item.id, 'fontWeight', v)}
                  options={FONT_WEIGHT_OPTIONS}
                />
                <NumberField
                  label="Font size (pt)"
                  value={item.fontSize}
                  onChange={(v) => updateText(item.id, 'fontSize', v)}
                  step={1}
                  min={6}
                />
                <NumberField
                  label="Height (mm)"
                  value={item.textExtrusionDistance}
                  onChange={(v) => updateText(item.id, 'textExtrusionDistance', v)}
                  step={0.1}
                  min={0.1}
                />
                <NumberField
                  label="Letter spacing (mm)"
                  value={item.letterSpacing ?? 0}
                  onChange={(v) => updateText(item.id, 'letterSpacing', v)}
                  step={0.1}
                />
                <NumberField
                  label="Curve resolution"
                  value={item.curveSegments ?? 24}
                  onChange={(v) => updateText(item.id, 'curveSegments', v)}
                  step={1}
                  min={4}
                  max={64}
                />
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-[var(--text-primary)]">
                    Position
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={item.position}
                    aria-label="Position"
                    onChange={(e) => updateText(item.id, 'position', Number(e.target.value))}
                    className="h-2 w-20 shrink-0 cursor-pointer rounded-lg accent-violet-600"
                    style={{ '--range-pct': `${item.position}%` }}
                  />
                  <NumberField
                    value={item.position}
                    onChange={(v) => updateText(item.id, 'position', v)}
                    step={1}
                    min={0}
                    max={100}
                    unit="%"
                  />
                </div>
              </div>
              <button
                type="button"
                className="text-[var(--text-muted)] hover:text-[var(--text-danger)]"
                onClick={() =>
                  patch((s) => ({
                    ...s,
                    wallTexts: s.wallTexts.filter((t) => t.id !== item.id),
                  }))
                }
                aria-label="Delete text"
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
                wallTexts: [...s.wallTexts, newWallText()],
              }))
            }
          >
            + ADD TEXT
          </button>
        </>
      )}

      <p className="help-note">
        * Each text wraps around the outer cutter wall; use Position to place it along the total perimeter.
      </p>
    </Accordion>
  )
}
