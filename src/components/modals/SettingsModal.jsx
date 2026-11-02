import { Camera, CreditCard, Eye, EyeOff, KeyRound, Loader2, SlidersHorizontal, Sparkles, User, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/useAuth.js'
import { useSettings } from '../../context/useSettings.js'
import { useTheme } from '../../context/useTheme.js'
import { getUserProfile, updateUserProfile, uploadAvatar } from '../../lib/dbClient.js'
import { primaryButtonClass } from '../ui/buttonStyles.js'
import { Select } from '../ui/Select.jsx'
import { Toggle } from '../ui/Toggle.jsx'

const TABS = [
  { id: 'account', label: 'My Account', icon: UserRound },
  { id: 'export', label: 'Export Preferences', icon: SlidersHorizontal },
  { id: 'billing', label: 'Billing', icon: CreditCard },
]

const PRINT_FORMATS = [
  { value: 'stl', label: 'STL' },
  { value: '3mf', label: '3MF' },
  { value: 'obj', label: 'OBJ' },
  { value: 'step', label: 'STEP' },
]

const STENCIL_FORMATS = [
  { value: 'svg', label: 'SVG' },
  { value: 'stl', label: 'STL' },
]

const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

const fieldClass =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2.5 text-[14px] text-[var(--text-primary)] outline-none transition focus:border-[var(--accent)]'

function FieldLabel({ htmlFor, children }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]">
      {children}
    </label>
  )
}

export function SettingsModal() {
  const { user, pending, updatePassword } = useAuth()
  const {
    settingsModalOpen,
    closeSettingsModal,
    setView,
    userPreferences,
    updateUserPreferences,
  } = useSettings()
  const { isDark, toggleTheme } = useTheme()
  const fileRef = useRef(null)
  const [tab, setTab] = useState('account')
  const [planTier, setPlanTier] = useState('free')
  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordPending, setPasswordPending] = useState(false)

  const isPro = planTier === 'pro'

  useEffect(() => {
    if (!settingsModalOpen) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') closeSettingsModal()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settingsModalOpen, closeSettingsModal])

  useEffect(() => {
    if (settingsModalOpen) return
    setPasswordOpen(false)
    setPassword('')
    setConfirmPassword('')
    setShowPassword(false)
    setPasswordError('')
    setPasswordPending(false)
  }, [settingsModalOpen])

  useEffect(() => {
    if (!settingsModalOpen || !user) return undefined
    let cancelled = false
    getUserProfile()
      .then((profile) => {
        if (cancelled) return
        setPlanTier(profile?.plan_tier === 'pro' ? 'pro' : 'free')
        setDisplayName(profile?.display_name ?? '')
        setAvatarUrl(profile?.avatar_url ?? '')
      })
      .catch(() => {
        if (!cancelled) setPlanTier('free')
      })
    return () => {
      cancelled = true
    }
  }, [settingsModalOpen, user])

  if (!settingsModalOpen) return null

  const openBilling = () => {
    if (isPro) {
      toast('Billing portal is not connected yet. Plan changes still go through checkout.', { icon: '💳' })
    }
    closeSettingsModal()
    setView('pricing')
  }

  const onAvatarFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !user?.id) return
    if (!AVATAR_TYPES.has(file.type)) {
      toast.error('Use a PNG, JPG, WEBP, or GIF image.')
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error('Avatar images must be 2 MB or smaller.')
      return
    }
    setUploading(true)
    try {
      const url = await uploadAvatar(user.id, file)
      setAvatarUrl(url)
      toast.success('Photo uploaded. Save profile to keep it.')
    } catch (err) {
      toast.error(err?.message || 'Could not upload that photo.')
    } finally {
      setUploading(false)
    }
  }

  const saveProfile = async () => {
    if (!user?.id || saving) return
    setSaving(true)
    try {
      const row = await updateUserProfile(user.id, {
        display_name: displayName.trim(),
        avatar_url: avatarUrl || null,
      })
      setDisplayName(row?.display_name ?? '')
      setAvatarUrl(row?.avatar_url ?? '')
      toast.success('Profile saved.')
    } catch (err) {
      toast.error(err?.message || 'Could not save your profile.')
    } finally {
      setSaving(false)
    }
  }

  const submitPassword = async (event) => {
    event.preventDefault()
    if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match.')
      return
    }
    setPasswordPending(true)
    setPasswordError('')
    try {
      await updatePassword(password)
      setPassword('')
      setConfirmPassword('')
      setPasswordOpen(false)
      toast.success('Password updated.')
    } catch (err) {
      setPasswordError(err?.message || 'Could not update the password.')
    } finally {
      setPasswordPending(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      className="settings-overlay fixed inset-0 z-[80] flex flex-col bg-[var(--bg-base)] text-[var(--text-primary)]"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-header)] px-5 sm:px-8">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.16em] text-[var(--text-muted)]">CUTTER STUDIO</p>
          <h2 id="settings-modal-title" className="text-[16px] font-semibold leading-tight">
            Settings
          </h2>
        </div>
        <button
          type="button"
          onClick={closeSettingsModal}
          aria-label="Close settings"
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        >
          <X size={15} />
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-sidebar)] p-3 md:w-64 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-4">
          {TABS.map((item) => {
            const Icon = item.icon
            const active = tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium transition ${
                  active
                    ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon size={16} className={active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
                {item.label}
              </button>
            )
          })}
          <div className="mt-auto hidden items-center justify-between gap-3 rounded-lg px-3 py-3 md:flex">
            <div>
              <p id="settings-theme-label" className="text-[12px] font-medium text-[var(--text-primary)]">
                Dark theme
              </p>
              <p className="text-[11px] text-[var(--text-muted)]">{isDark ? 'Dark' : 'Light'}</p>
            </div>
            <Toggle checked={isDark} onChange={toggleTheme} labelledBy="settings-theme-label" />
          </div>
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-10 sm:py-12">
            {tab === 'account' ? (
              <section className="flex flex-col gap-8">
                <div>
                  <h3 className="text-[22px] font-semibold tracking-tight">My Account</h3>
                  <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
                    How you appear in Cutter Studio. The editor stays open behind this screen.
                  </p>
                </div>

                <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={!user || uploading}
                    aria-label="Upload avatar"
                    className="group relative size-28 shrink-0 overflow-hidden rounded-full border border-[var(--border-strong)] bg-[var(--bg-input)] shadow-[var(--shadow)] disabled:cursor-not-allowed"
                  >
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <span className="flex size-full items-center justify-center text-[var(--text-muted)]">
                        <User size={36} strokeWidth={1.5} />
                      </span>
                    )}
                    <span
                      className={`absolute inset-0 flex items-center justify-center bg-black/55 text-white transition ${
                        uploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      {uploading ? <Loader2 size={22} className="animate-spin" /> : <Camera size={20} />}
                    </span>
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={onAvatarFile}
                  />
                  <div>
                    <p className="text-[14px] font-medium">Profile photo</p>
                    <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-[var(--text-muted)]">
                      Hover the portrait and choose an image. PNG, JPG, WEBP, or GIF up to 2 MB.
                    </p>
                  </div>
                </div>

                <div className="grid gap-5">
                  <div>
                    <FieldLabel htmlFor="settings-display-name">Display Name</FieldLabel>
                    <input
                      id="settings-display-name"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      disabled={!user || saving}
                      maxLength={80}
                      placeholder="Your name"
                      className={fieldClass}
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="settings-email">Account Email</FieldLabel>
                    <input
                      id="settings-email"
                      value={user?.email || ''}
                      readOnly
                      placeholder="Not signed in"
                      className={`${fieldClass} cursor-default text-[var(--text-secondary)]`}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={saveProfile}
                    disabled={!user || saving || uploading}
                    className={`h-10 rounded-lg px-4 text-[13px] ${primaryButtonClass}`}
                  >
                    {saving ? 'Saving…' : 'Save Profile'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPasswordOpen((open) => !open)}
                    disabled={!user}
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--border-strong)] px-4 text-[13px] font-medium text-[var(--text-primary)] transition hover:bg-[var(--bg-input)] disabled:opacity-50"
                  >
                    <KeyRound size={15} />
                    Change Password
                  </button>
                </div>

                {passwordOpen ? (
                  <form className="flex max-w-md flex-col gap-2.5" onSubmit={submitPassword}>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        placeholder="New password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className={`${fieldClass} pr-10`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((visible) => !visible)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute top-1/2 right-3 -translate-y-1/2 text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      placeholder="Confirm new password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      className={fieldClass}
                    />
                    {passwordError ? <p className="text-[12px] text-[var(--text-danger)]">{passwordError}</p> : null}
                    <button
                      type="submit"
                      disabled={passwordPending || pending}
                      className={`h-10 rounded-lg px-4 text-[13px] ${primaryButtonClass}`}
                    >
                      {passwordPending ? 'Updating…' : 'Update Password'}
                    </button>
                  </form>
                ) : null}
              </section>
            ) : null}

            {tab === 'export' ? (
              <section className="flex flex-col gap-6">
                <div>
                  <h3 className="text-[22px] font-semibold tracking-tight">Export Preferences</h3>
                  <p className="mt-1 max-w-lg text-[13px] leading-relaxed text-[var(--text-secondary)]">
                    Stencils are a 2D cut file. Cutters and stamps are a 3D file. Each keeps its own default.
                  </p>
                </div>
                <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5">
                  <Select
                    label="Default 3D Print Format"
                    value={userPreferences.default3DFormat}
                    options={PRINT_FORMATS}
                    onChange={(value) => updateUserPreferences({ default3DFormat: value })}
                  />
                  <Select
                    label="Default Stencil Format"
                    value={userPreferences.defaultStencilFormat}
                    options={STENCIL_FORMATS}
                    onChange={(value) => updateUserPreferences({ defaultStencilFormat: value })}
                  />
                </div>
                <p className="text-[12px] text-[var(--text-muted)]">Saved on this device.</p>
              </section>
            ) : null}

            {tab === 'billing' ? (
              <section className="flex flex-col gap-6">
                <div>
                  <h3 className="text-[22px] font-semibold tracking-tight">Billing</h3>
                  <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
                    {isPro ? 'Pro is active on this account.' : 'You are on the free plan.'}
                  </p>
                </div>
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
                  <p className="text-[13px] font-semibold tracking-wide text-[var(--accent)]">
                    {isPro ? 'PRO' : 'FREE'}
                  </p>
                  <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[var(--text-secondary)]">
                    {isPro
                      ? 'Checkout is the billing screen until a customer portal is connected.'
                      : 'Card payments use Paddle. EGP payments use Paymob.'}
                  </p>
                  <button
                    type="button"
                    onClick={openBilling}
                    className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 text-[13px] font-semibold text-white shadow-md transition hover:from-violet-500 hover:to-fuchsia-500"
                  >
                    <Sparkles size={15} />
                    {isPro ? 'Manage Subscription' : 'Upgrade to Pro'}
                  </button>
                </div>
              </section>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  )
}
