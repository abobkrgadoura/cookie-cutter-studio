import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Cookie, HelpCircle, Layers, Lightbulb, Scissors, SquareDashed, Stamp } from 'lucide-react'
import { THING_OPTIONS } from '../../lib/constants.js'
import { useSettings } from '../../context/useSettings.js'

const THING_ICONS = {
  cutter: Scissors,
  stamp: Stamp,
  cutterStamp: Layers,
  sable: Cookie,
  stencil: SquareDashed,
  lightbox: Lightbulb,
}

function Thumb({ id }) {
  const Icon = THING_ICONS[id] ?? Scissors
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-[#3a3a4e] text-white">
      <Icon size={16} strokeWidth={1.75} />
    </div>
  )
}

export function ThingToMake() {
  const { settings, patch } = useSettings()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const current = THING_OPTIONS.find((o) => o.id === settings.thingToMake)

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <section className="border-b border-[var(--border)] px-4 py-4">
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
        Product Type
        <HelpCircle size={13} className="text-[var(--text-muted)]" />
      </div>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-[4px] border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2.5"
        >
          <span className="text-[14px]">{current?.label}</span>
          <ChevronDown size={14} className="text-[var(--text-secondary)]" />
        </button>
        {open && (
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--bg-menu)] py-1 shadow-[var(--shadow)]">
            {THING_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  patch({ thingToMake: opt.id })
                  setOpen(false)
                }}
                className={`flex w-full cursor-pointer items-center gap-3 px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-violet-50 hover:text-violet-700 ${
                  opt.id === settings.thingToMake ? 'bg-violet-50 text-violet-700' : 'text-[var(--text-primary)]'
                }`}
              >
                <Thumb id={opt.id} />
                <span className="flex-1">{opt.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
