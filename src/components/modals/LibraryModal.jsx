import { Library, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { LibraryDesignGrid } from '../library/LibraryDesignGrid.jsx'
import { useAuth } from '../../context/useAuth.js'
import { useSettings } from '../../context/useSettings.js'
import { deleteDesignById, getUserDesigns } from '../../lib/dbClient.js'
import { applyImageFallback, resolveMediaSrc } from '../../lib/mediaSrc.js'
import { formatDim } from '../../lib/units.js'

function formatCreatedAt(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const THING_LABELS = {
  cutter: 'Cutter',
  stencil: 'Stencil',
  lightbox: 'Shadow Lightbox',
  cutterStamp: 'Cutter & Stamp',
  sable: 'Sablé / Linzer',
  stamp: 'Stamp',
  cutterSet: 'Cutter Set',
  practice: 'Practice Cookie',
  multi: 'Multi Cutter',
}

export function LibraryModal({ open, onClose }) {
  const { library, profiles, loadLibraryDesign, removeFromLibrary, deleteProfile, applyCloudDesign, cloudRevision } = useSettings()
  const { user } = useAuth()
  const [cloudDesigns, setCloudDesigns] = useState([])
  const [cloudError, setCloudError] = useState('')
  const [cloudLoading, setCloudLoading] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => {
    if (!open) return undefined
    if (!user) {
      setCloudDesigns([])
      setCloudError('')
      setCloudLoading(false)
      return undefined
    }

    let cancelled = false
    setCloudLoading(true)
    setCloudError('')
    getUserDesigns()
      .then((rows) => {
        if (!cancelled) setCloudDesigns(Array.isArray(rows) ? rows : [])
      })
      .catch((err) => {
        if (!cancelled) setCloudError(err?.message || 'Could not load your designs.')
      })
      .finally(() => {
        if (!cancelled) setCloudLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, user, cloudRevision])

  const openCloudDesign = (design) => {
    const loaded = applyCloudDesign(design)
    if (!loaded) {
      toast.error('This design has no settings to load.')
      return
    }
    onClose()
  }

  const removeCloudDesign = async (design) => {
    if (!design?.id || deletingId) return

    const previous = cloudDesigns
    setDeletingId(design.id)

    // Optimistic UI Update
    setCloudDesigns((rows) => rows.filter((row) => row.id !== design.id))

    try {
      await deleteDesignById(design.id)
      const local = profiles.find((profile) => profile.name === design.name)
      if (local) deleteProfile(local.id)
      toast.success('Design deleted successfully')
    } catch (err) {
      console.error('Cloud delete failed:', err)
      setCloudDesigns(previous) // Revert on failure
      toast.error(err.message || 'Deletion failed')
    } finally {
      setDeletingId(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-[var(--border-strong)] bg-[var(--bg-card)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Library size={18} className="text-[var(--accent)]" />
            <h3 className="text-base font-semibold">My Library</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-input)] hover:text-[var(--text-primary)]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h4 className="mb-2 text-[12px] font-semibold tracking-wide text-[var(--text-secondary)]">
            Cloud Library
          </h4>
          {!user ? (
            <p className="mb-5 text-[12px] text-[var(--text-muted)]">Please log in</p>
          ) : cloudLoading ? (
            <p className="mb-5 text-[12px] text-[var(--text-muted)]">Loading designs…</p>
          ) : cloudError ? (
            <p className="mb-5 text-[12px] text-[var(--text-danger)]">{cloudError}</p>
          ) : cloudDesigns.length === 0 ? (
            <p className="mb-5 text-[12px] text-[var(--text-muted)]">You haven&apos;t saved any designs yet</p>
          ) : (
            <ul className="mb-5 flex flex-col gap-2">
              {cloudDesigns.map((entry) => {
                const created = formatCreatedAt(entry.created_at)
                const label = entry.name || 'My Cutter'
                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-sidebar)] p-3 transition-colors hover:border-violet-500/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-bold text-[var(--text-primary)]">
                        {label}
                      </span>
                      {created ? (
                        <span className="block text-[11px] font-medium text-[var(--text-muted)]">{created}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openCloudDesign(entry)}
                        className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent)] transition hover:bg-[var(--accent)] hover:text-white"
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        onClick={() => removeCloudDesign(entry)}
                        disabled={deletingId === entry.id}
                        aria-label="Delete from cloud"
                        className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--bg-input)] hover:text-[var(--text-danger)] disabled:opacity-50"
                      >
                        <Trash2 size={16} />
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <LibraryDesignGrid onSelect={onClose} />
          {library.length === 0 ? (
            <p className="mt-4 text-center text-[12px] text-[var(--text-muted)]">
              Check &ldquo;Add design to my library&rdquo; below the 3D preview to save a cutter here.
            </p>
          ) : (
            <>
              <h4 className="mt-5 mb-2 text-[12px] font-semibold tracking-wide text-[var(--text-secondary)]">
                Saved
              </h4>
              <ul className="flex flex-col gap-2">
                {library.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-sidebar)] p-2 transition-colors hover:border-violet-500/50"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      {/* المربع الذي سيعرض صورة الـ 3D المصغرة */}
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-input)]">
                        {entry.thumbnail ? (
                          <img
                            src={resolveMediaSrc(entry.thumbnail)}
                            alt={entry.name}
                            className="h-full w-full object-cover bg-white"
                            onError={applyImageFallback}
                          />
                        ) : (
                          <Library className="text-[var(--text-muted)]" size={16} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-bold text-[var(--text-primary)]">{entry.name}</p>
                        <p className="text-[11px] font-medium text-[var(--text-muted)]">
                          {THING_LABELS[entry.thingToMake] ?? entry.thingToMake} &middot;{' '}
                          {formatDim(entry.width, entry.unit)} &times; {formatDim(entry.height, entry.unit)}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 pr-1">
                      <button
                        type="button"
                        onClick={() => {
                          loadLibraryDesign(entry.id)
                          onClose()
                        }}
                        className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent)] transition hover:bg-[var(--accent)] hover:text-white"
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromLibrary(entry.id)}
                        aria-label="Remove from library"
                        className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--bg-input)] hover:text-[var(--text-danger)]"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}