import { ChevronDown, Moon, Sun, User } from 'lucide-react'
import { useRef, useState } from 'react'
import { useAuth } from '../../context/useAuth.js'
import { useSettings } from '../../context/useSettings.js'
import { useTheme } from '../../context/useTheme.js'
import { LibraryModal } from '../modals/LibraryModal.jsx'
import { AccountMenu } from './AccountMenu.jsx'

const NAV = ['DESIGNER', 'MY LIBRARY', 'DOCS']

export function Header() {
  const { isDark, toggleTheme } = useTheme()
  const { user } = useAuth()
  const { view, setView, image } = useSettings()
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const accountAnchorRef = useRef(null)

  const themeLabel = isDark ? 'Theme: Dark' : 'Theme: Light'
  const activeNav = libraryOpen ? 'MY LIBRARY' : view === 'pricing' ? null : 'DESIGNER'

  const handleNavClick = (item) => {
    if (item === 'DESIGNER') {
      setLibraryOpen(false)
      if (view === 'pricing') {
        setView(image ? 'editor' : 'landing')
        return
      }
      setView(view === 'editor' ? 'editor' : 'landing')
    }
    if (item === 'MY LIBRARY') setLibraryOpen(true)
  }

  return (
    <>
    <header className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--border)] bg-[var(--bg-header)] px-4">
      <button
        type="button"
        onClick={() => {
          setLibraryOpen(false)
          setView('landing')
        }}
        className="justify-self-start text-[18px] font-semibold tracking-tight"
        style={{ color: 'var(--accent)' }}
      >
        Cutter Studio
      </button>

      <nav className="flex items-center gap-6 text-[12px] font-semibold tracking-wide">
        {NAV.map((item) => {
          const active = item === activeNav
          return (
            <button
              key={item}
              type="button"
              onClick={() => handleNavClick(item)}
              className={
                active
                  ? `border-b-2 border-violet-500 pb-1 font-semibold ${
                      isDark
                        ? 'text-white shadow-[0_10px_14px_-10px_rgba(139,92,246,0.95)]'
                        : 'text-violet-700'
                    }`
                  : 'border-b-2 border-transparent pb-1 text-[var(--text-muted)] transition-colors duration-200 hover:text-[var(--text-primary)]'
              }
            >
              {item}
            </button>
          )
        })}
      </nav>

      <div className="flex items-center justify-self-end gap-3">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={themeLabel}
          className="group relative rounded-md p-1.5 text-[var(--text-secondary)] transition hover:bg-[var(--bg-input)] hover:text-[var(--text-primary)]"
        >
          {isDark ? <Moon size={16} strokeWidth={1.75} /> : <Sun size={16} strokeWidth={1.75} />}
          <span
            role="tooltip"
            className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 -translate-x-1/2 rounded-md bg-neutral-900 px-2 py-1 text-[11px] font-medium whitespace-nowrap text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {themeLabel}
          </span>
        </button>
        <div className="relative" ref={accountAnchorRef}>
          <button
            type="button"
            onClick={() => setAccountOpen((v) => !v)}
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            aria-label={user ? 'Account' : 'Login'}
            className="flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-header)] py-1 pr-2.5 pl-1.5 text-[12px] font-medium text-[var(--text-primary)] shadow-sm transition hover:border-[var(--accent)]"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-[var(--bg-canvas)] text-[var(--text-secondary)]">
              <User size={14} strokeWidth={1.75} />
            </span>
            <span>{user ? 'Account' : 'Login'}</span>
            <ChevronDown
              size={14}
              strokeWidth={2}
              className={`shrink-0 text-[var(--text-muted)] transition-transform ${accountOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {accountOpen && (
            <AccountMenu anchorRef={accountAnchorRef} onClose={() => setAccountOpen(false)} />
          )}
        </div>
      </div>

    </header>
    <LibraryModal open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </>
  )
}
