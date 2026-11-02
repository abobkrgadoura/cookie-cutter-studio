import { Eye, EyeOff, LogIn, LogOut, Settings, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '../../context/useAuth.js'
import { useSettings } from '../../context/useSettings.js'
import { primaryButtonClass } from '../ui/buttonStyles.js'

/**
 * Account dropdown. Signed-in sessions show email, Settings, and Log out.
 * Signed-out sessions keep the email login / signup form, which submits
 * into `AuthContext` (local session via `authClient.js` until Firebase or
 * Supabase replaces that adapter).
 */
export function AccountMenu({ onClose, anchorRef }) {
  const { user, error, pending, signIn, signUp, signOut } = useAuth()
  const { settingsModalOpen, openSettingsModal, closeSettingsModal } = useSettings()
  const [tab, setTab] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    function handleClick(e) {
      if (anchorRef?.current && !anchorRef.current.contains(e.target)) onClose()
    }
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, anchorRef])

  const submit = async (event) => {
    event.preventDefault()
    try {
      if (tab === 'login') await signIn(email, password)
      else await signUp(email, password)
      onClose()
    } catch {
      // `error` on the auth context is rendered below.
    }
  }

  const handleSignOut = async () => {
    try {
      await signOut()
      onClose()
    } catch {
      // `error` stays on the auth context if sign-out fails.
    }
  }

  return (
    <div
      role="menu"
      className="absolute top-full right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-neutral-200/80 bg-white py-1.5 text-neutral-900 shadow-[0_12px_32px_rgba(15,15,25,0.16)]"
    >
      {user ? (
        <>
          <p
            aria-disabled="true"
            className="cursor-default truncate px-3 py-2 text-[12px] text-neutral-500 select-text"
          >
            {user.email}
          </p>
          <div className="mx-2 my-1 h-px bg-neutral-100" />
          <button
            type="button"
            role="menuitem"
            aria-expanded={settingsModalOpen}
            onClick={() => {
              onClose()
              if (settingsModalOpen) closeSettingsModal()
              else openSettingsModal()
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-neutral-800 transition hover:bg-neutral-100"
          >
            <Settings size={15} strokeWidth={1.75} className="text-neutral-500" />
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={pending}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-neutral-800 transition hover:bg-neutral-100 disabled:opacity-50"
          >
            <LogOut size={15} strokeWidth={1.75} className="text-neutral-500" />
            Log out
          </button>
        </>
      ) : (
        <div className="px-3 py-2">
          <div className="mb-3 flex gap-1 rounded-md bg-neutral-100 p-1 text-[12px] font-semibold">
            <button
              type="button"
              onClick={() => setTab('login')}
              className={`flex-1 rounded px-2 py-1.5 transition ${
                tab === 'login' ? 'bg-[var(--accent)] text-white' : 'text-neutral-500'
              }`}
            >
              Log In
            </button>
            <button
              type="button"
              onClick={() => setTab('signup')}
              className={`flex-1 rounded px-2 py-1.5 transition ${
                tab === 'signup' ? 'bg-[var(--accent)] text-white' : 'text-neutral-500'
              }`}
            >
              Sign Up
            </button>
          </div>
          <form className="flex flex-col gap-2.5" onSubmit={submit}>
            <input
              type="email"
              required
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-[12px] text-neutral-900 outline-none focus:border-[var(--accent)]"
            />
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 pr-8 text-[12px] text-neutral-900 outline-none focus:border-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-neutral-400 transition hover:text-neutral-700"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {error ? <p className="text-[11px] text-[var(--text-danger)]">{error}</p> : null}
            <button
              type="submit"
              disabled={pending}
              className={`mt-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[12px] ${primaryButtonClass}`}
            >
              {tab === 'login' ? <LogIn size={14} /> : <UserPlus size={14} />}
              {pending ? 'Please wait…' : tab === 'login' ? 'Log In' : 'Create Account'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
