import { useEffect, useRef, useState } from 'react'
import { ChevronDown, RotateCcw, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/useAuth.js'
import { useSettings } from '../../context/useSettings.js'
import { DEFAULT_PROFILE_NAME } from '../../lib/constants.js'
import { deleteDesignFromCloud, getUserProfile, saveDesignToCloud } from '../../lib/dbClient.js'
import { designUsesProFeatures } from '../../lib/proFeatures.js'
import { primaryButtonClass } from '../ui/buttonStyles.js'

export function ProfileSection() {
  const {
    settings,
    profileModified,
    resetDefaults,
    profiles,
    activeProfileName,
    saveProfile,
    loadProfile,
    deleteProfile,
  } = useSettings()
  const { user } = useAuth()
  const [draft, setDraft] = useState(activeProfileName)
  const [open, setOpen] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [isPro, setIsPro] = useState(false)
  const rootRef = useRef(null)
  const flashTimer = useRef(0)

  useEffect(() => {
    setDraft(activeProfileName)
  }, [activeProfileName])

  useEffect(() => {
    const onDoc = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => () => window.clearTimeout(flashTimer.current), [])

  useEffect(() => {
    let cancelled = false
    getUserProfile()
      .then((p) => {
        if (!cancelled) setIsPro(p?.plan_tier === 'pro')
      })
      .catch(() => {
        if (!cancelled) setIsPro(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const activeProfile = profiles.find((profile) => profile.name === activeProfileName)
  const canDelete = Boolean(activeProfile)

  const commitDelete = async () => {
    if (!activeProfile || saving || deleting) return
    const profile = activeProfile
    setDeleting(true)
    setSaveError('')
    try {
      if (user?.id) {
        await deleteDesignFromCloud(user.id, profile.name)
      }
      const removed = deleteProfile(profile.id)
      setOpen(false)
      if (removed) toast.success('Profile deleted successfully')
    } catch (err) {
      const message = err?.message || 'Could not delete this profile from the cloud.'
      setSaveError(message)
      toast.error(message)
    } finally {
      setDeleting(false)
    }
  }

  const commitSave = async () => {
    if (saving) return
    if (!isPro && designUsesProFeatures(settings)) {
      toast.error('👑 You are using Pro features! Please upgrade your plan to save this design.', {
        duration: 4000,
      })
      return
    }
    const trimmed = String(draft ?? '').trim()
    const named = trimmed && trimmed.toLowerCase() !== DEFAULT_PROFILE_NAME.toLowerCase()
    const name = named ? trimmed : 'My Cutter'
    if (named) saveProfile(trimmed)
    setSaving(true)
    setSaveError('')
    try {
      const row = await saveDesignToCloud(name, settings)
      if (!row) throw new Error('Supabase is not configured. Please add .env variables.')
      setOpen(false)
      setSavedFlash(true)
      toast.success('Design saved to Cloud Library!')
      window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1200)
    } catch (err) {
      setSavedFlash(false)
      const message = err?.message || 'You must be logged in to save'
      setSaveError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="border-b border-[var(--border)] px-4 py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="sidebar-section-title">Profile</span>
        {profileModified ? (
          <span className="text-[11px] text-[var(--text-muted)]">Modified</span>
        ) : null}
      </div>

      <div className="mb-2 flex items-stretch gap-2">
        <div ref={rootRef} className="relative min-w-0 flex-1">
          <div className="flex items-center rounded-[4px] border border-[var(--border)] bg-[var(--bg-input)] focus-within:border-violet-500">
            <input
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setSaveError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitSave()
                }
              }}
              aria-label="Profile name"
              placeholder="Profile name"
              title={draft}
              className="min-w-0 flex-1 bg-transparent px-2.5 py-2 text-[13px] outline-none"
            />
            <button
              type="button"
              aria-label="Saved profiles"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="shrink-0 px-2 py-2 text-[var(--text-secondary)]"
            >
              <ChevronDown
                size={14}
                className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
          {open ? (
            <div className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-[6px] border border-[var(--border)] bg-[var(--bg-menu)] py-1 shadow-[var(--shadow)]">
              <button
                type="button"
                onClick={() => {
                  resetDefaults()
                  setSaveError('')
                  setOpen(false)
                }}
                className={`block w-full cursor-pointer truncate px-3 py-2 text-left text-[13px] transition-colors hover:bg-violet-50 hover:text-violet-700 ${
                  activeProfileName === DEFAULT_PROFILE_NAME
                    ? 'bg-violet-50 text-violet-700'
                    : 'text-[var(--text-primary)]'
                }`}
              >
                {DEFAULT_PROFILE_NAME}
              </button>
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => {
                    loadProfile(profile.id)
                    setSaveError('')
                    setOpen(false)
                  }}
                  className={`block w-full cursor-pointer truncate px-3 py-2 text-left text-[13px] transition-colors hover:bg-violet-50 hover:text-violet-700 ${
                    profile.name === activeProfileName
                      ? 'bg-violet-50 text-violet-700'
                      : 'text-[var(--text-primary)]'
                  }`}
                >
                  {profile.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={commitSave}
          disabled={saving}
          className={`shrink-0 rounded-[4px] px-3 text-[12px] tracking-wide ${primaryButtonClass}`}
        >
          {saving ? 'Saving…' : savedFlash ? 'Saved' : 'Save'}
        </button>
        {canDelete ? (
          <button
            type="button"
            aria-label={`Delete ${activeProfile.name}`}
            onClick={commitDelete}
            disabled={deleting}
            className="flex shrink-0 items-center justify-center rounded-[4px] border border-[var(--border)] px-2.5 text-violet-600 transition-colors hover:bg-violet-100 hover:text-violet-800 disabled:opacity-50"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
      {saveError ? <p className="mb-2 text-[11px] text-[var(--text-danger)]">{saveError}</p> : null}

      <button
        type="button"
        onClick={resetDefaults}
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-violet-600 transition-colors hover:text-violet-800"
      >
        <RotateCcw size={12} />
        RESET TO DEFAULTS
      </button>
    </section>
  )
}
