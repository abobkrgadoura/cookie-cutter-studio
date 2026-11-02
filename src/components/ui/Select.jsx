import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

export function Select({ value, options, onChange, label, className = '' }) {
  const [open, setOpen] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  const ref = useRef(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const toggle = () => {
    setOpen((isOpen) => {
      const next = !isOpen
      if (next && ref.current) {
        const rect = ref.current.getBoundingClientRect()
        const spaceBelow = window.innerHeight - rect.bottom
        setOpenUp(spaceBelow < 160 && rect.top > spaceBelow)
      }
      return next
    })
  }

  return (
    <div className={`flex min-w-0 items-center justify-between gap-3 ${open ? 'relative z-30' : ''} ${className}`}>
      {label ? (
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-[var(--text-primary)]">{label}</span>
      ) : null}
      <div ref={ref} className={label ? 'relative w-[9.5rem] shrink-0' : 'relative min-w-0 flex-1'}>
        <button
          type="button"
          onClick={toggle}
          title={current?.label}
          className="flex h-8 w-full items-center justify-between rounded-[4px] border border-[var(--border)] bg-[var(--bg-input)] px-2 text-left"
        >
          <span className="field-value min-w-0 flex-1 truncate">{current?.label}</span>
          <ChevronDown size={14} className="ml-1 shrink-0 text-[var(--text-secondary)]" />
        </button>
        {open && (
          <div
            className={`absolute right-0 z-50 w-max min-w-full overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--bg-menu)] py-1 shadow-[var(--shadow)] ${
              openUp ? 'bottom-full mb-1' : 'mt-1'
            }`}
          >
            {options.map((opt) => {
              const active = opt.value === value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className={`block w-full cursor-pointer whitespace-nowrap px-3 py-2 text-left text-[13px] transition-colors hover:bg-violet-50 hover:text-violet-700 ${
                    active ? 'bg-violet-50 text-violet-700' : 'text-[var(--text-primary)]'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
