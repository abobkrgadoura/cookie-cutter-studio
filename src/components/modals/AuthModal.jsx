import { Eye, EyeOff, Loader2, LogIn, Sparkles, UserPlus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '../../context/useAuth.js'
import { primaryButtonClass } from '../ui/buttonStyles.js'

export function AuthModal() {
  const { user, error, pending, signIn, signUp, authModalOpen, closeAuthModal } = useAuth()
  const [tab, setTab] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    if (!authModalOpen) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') closeAuthModal()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [authModalOpen, closeAuthModal])

  useEffect(() => {
    if (authModalOpen) return
    setTab('login')
    setEmail('')
    setPassword('')
    setShowPassword(false)
  }, [authModalOpen])

  useEffect(() => {
    if (user && authModalOpen) closeAuthModal()
  }, [user, authModalOpen, closeAuthModal])

  if (!authModalOpen || user) return null

  const isLogin = tab === 'login'

  const submit = async (event) => {
    event.preventDefault()
    try {
      if (isLogin) await signIn(email, password)
      else await signUp(email, password)
      closeAuthModal()
    } catch {
      // `error` on the auth context is rendered below.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ zIndex: 80 }}>
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-xs"
        onClick={closeAuthModal}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="relative w-full overflow-hidden rounded-xl border border-[var(--border-strong)] shadow-2xl"
        style={{
          maxWidth: 400,
          background: 'color-mix(in srgb, var(--bg-card) 82%, transparent)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{ background: 'linear-gradient(90deg, transparent, #a78bfa, transparent)' }}
        />

        <button
          type="button"
          onClick={closeAuthModal}
          aria-label="Close"
          className="absolute z-10 rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--bg-input)] hover:text-[var(--text-primary)]"
          style={{ top: 12, right: 12 }}
        >
          <X size={16} />
        </button>

        <div className="relative px-5 pt-7 pb-5">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-900/20">
            <Sparkles size={20} />
          </div>
          <h2 id="auth-modal-title" className="text-center text-base font-semibold text-[var(--text-primary)]">
            {isLogin ? 'Welcome back' : 'Create your account'}
          </h2>
          <p className="mt-1 text-center text-[12px] text-[var(--text-secondary)]">
            Sign in to download your designs and upgrade to Pro.
          </p>

          <div className="mt-4 flex gap-1 rounded-md bg-[var(--bg-input)] p-1 text-[12px] font-semibold">
            <button
              type="button"
              onClick={() => setTab('login')}
              className={`flex-1 rounded-md px-2 py-1.5 transition ${
                isLogin
                  ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              Log In
            </button>
            <button
              type="button"
              onClick={() => setTab('signup')}
              className={`flex-1 rounded-md px-2 py-1.5 transition ${
                !isLogin
                  ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              Sign Up
            </button>
          </div>

          <form className="mt-4 flex flex-col gap-2.5" onSubmit={submit}>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@studio.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-violet-500"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">Password</span>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  placeholder="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2.5 pr-8 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-violet-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>
            {error ? <p className="text-[12px] text-[var(--text-danger)]">{error}</p> : null}
            <button
              type="submit"
              disabled={pending}
              className={`mt-1 flex items-center justify-center gap-2 rounded-md px-3 py-2.5 text-[13px] ${primaryButtonClass}`}
            >
              {pending ? <Loader2 size={15} className="animate-spin" /> : isLogin ? <LogIn size={15} /> : <UserPlus size={15} />}
              {pending ? 'Please wait…' : isLogin ? 'Log In' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
