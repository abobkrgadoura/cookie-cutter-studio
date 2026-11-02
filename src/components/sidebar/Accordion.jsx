import { ChevronDown } from 'lucide-react'

export function Accordion({ title, open, onToggle, children, trailing }) {
  return (
    <section className="border-b border-[var(--border)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="sidebar-section-title">{title}</span>
        <span className="flex items-center gap-2 text-[var(--text-secondary)]">
          {trailing}
          <ChevronDown
            size={16}
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </section>
  )
}

export function SettingRow({ label, children, align = 'center' }) {
  return (
    <div className={`mb-3 flex gap-3 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <div className="w-[92px] shrink-0 text-[13px] text-[var(--text-primary)]">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
