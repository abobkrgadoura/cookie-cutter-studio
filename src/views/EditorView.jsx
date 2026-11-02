import { ChevronDown, Download, Library, Link2, Loader2, Upload } from 'lucide-react'
import toast from 'react-hot-toast'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Sidebar } from '../components/sidebar/Sidebar.jsx'
import { Viewer3D } from '../components/viewer/Viewer3D.jsx'
import { useAuth } from '../context/useAuth.js'
import { useModel } from '../context/useModel.js'
import { useSettings } from '../context/useSettings.js'
import { ImageEditorView } from './ImageEditorView.jsx'
import { primaryButtonClass, solidActionButtonClass } from '../components/ui/buttonStyles.js'
import { getUserProfile } from '../lib/dbClient.js'
import { designUsesProFeatures } from '../lib/proFeatures.js'
import { buildStencilSvg } from '../lib/stencilSheet.js'
import { exportModel } from '../lib/stlExport.js'

const DOWNLOAD_FORMATS = [
  { id: 'stl', label: 'Download STL' },
  { id: 'obj', label: 'Download OBJ' },
  { id: '3mf', label: 'Download 3MF' },
  { id: 'step', label: 'Download STEP' },
]

const FOOTER_BTN = `flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3.5 text-[12px] ${solidActionButtonClass}`

// This view re-renders on every build start/finish (`isGenerating`, `model`).
// The workspaces read their own contexts, so those renders must not reach them.
const MemoSidebar = memo(Sidebar)
const MemoImageEditorView = memo(ImageEditorView)

export function EditorView() {
  const { user, openAuthModal } = useAuth()
  const {
    image,
    settings,
    setView,
    savedToLibrary,
    addToLibrary,
    removeCurrentFromLibrary,
    userPreferences,
  } = useSettings()
  const { model, stencilSheet, isGenerating } = useModel()
  const [exportError, setExportError] = useState(null)
  const [formatOpen, setFormatOpen] = useState(false)
  const [isPro, setIsPro] = useState(false)
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  )
  const [sheetActionsEl, setSheetActionsEl] = useState(null)
  const [workspace, setWorkspace] = useState('3d')
  const formatRef = useRef(null)
  const imageWorkspaceKey = `${image?.url ?? ''}|${image?.name ?? ''}|${image?.isSvg ? 'svg' : 'raster'}`
  const stencilMode = settings.thingToMake === 'stencil'
  const [trackedImageKey, setTrackedImageKey] = useState(imageWorkspaceKey)
  const [trackedThing, setTrackedThing] = useState(settings.thingToMake)

  if (imageWorkspaceKey !== trackedImageKey || settings.thingToMake !== trackedThing) {
    const imageChanged = imageWorkspaceKey !== trackedImageKey
    setTrackedImageKey(imageWorkspaceKey)
    setTrackedThing(settings.thingToMake)
    if (imageChanged) {
      setWorkspace(settings.thingToMake === 'stencil' ? '2d' : '3d')
    } else if (settings.thingToMake === 'stencil') {
      setWorkspace((current) => (current === '3d' || current === 'sheet' ? '2d' : current))
    } else {
      setWorkspace((current) => (current === 'sheet' ? '3d' : current))
    }
  }

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const sync = () => {
      setIsNarrow(media.matches)
      setSheetActionsEl(document.getElementById('editor-mobile-actions'))
    }
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

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

  useEffect(() => {
    if (!formatOpen) return
    const onDoc = (event) => {
      if (formatRef.current && !formatRef.current.contains(event.target)) setFormatOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setFormatOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [formatOpen])

  const handleDownload = useCallback(
    (format) => {
      if (!user) {
        setFormatOpen(false)
        toast('Please log in to download your designs.', { icon: '🔒' })
        openAuthModal()
        return
      }

      if (!isPro && designUsesProFeatures(settings)) {
        setFormatOpen(false)
        toast.error('👑 You are using Pro features! Please upgrade your plan to download this design.', {
          duration: 4000,
        })
        return
      }

      setFormatOpen(false)
      setExportError(null)
      try {
        const baseName = (image?.name || 'cutter').replace(/\.(svg|png|jpe?g|webp)$/i, '')
        if (format === 'svg') {
          if (!stencilSheet?.cutPaths?.length) {
            throw new Error('This stencil has no cut paths yet.')
          }
          const svg = buildStencilSvg(stencilSheet)
          const blob = new Blob([svg], { type: 'image/svg+xml' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `${baseName}-stencil.svg`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          setTimeout(() => URL.revokeObjectURL(url), 2000)
        } else {
          exportModel(model, settings, baseName, format)
        }
        toast.success('File downloaded successfully!')
      } catch (err) {
        console.error(`[EditorView] ${format.toUpperCase()} export failed:`, err)
        const message = err.message || `Failed to export ${format.toUpperCase()}.`
        setExportError(message)
        toast.error(message)
      }
    },
    [user, openAuthModal, isPro, model, stencilSheet, settings, image],
  )

  const handleLibraryToggle = (checked) => {
    if (!checked) {
      removeCurrentFromLibrary()
      return
    }
    if (!isPro && designUsesProFeatures(settings)) {
      toast.error('👑 You are using Pro features! Please upgrade your plan to save this design.', {
        duration: 4000,
      })
      return
    }
    addToLibrary()
  }

  const preferredFormatId =
    (stencilMode ? userPreferences?.defaultStencilFormat : userPreferences?.default3DFormat) ||
    (stencilMode ? 'svg' : 'stl')
  const svgReady = Boolean(stencilSheet?.cutPaths?.length)
  const meshReady = Boolean(model)
  const downloadFormats = useMemo(() => {
    const available = [
      ...(stencilMode && svgReady ? [{ id: 'svg', label: 'Download SVG' }] : []),
      ...(meshReady ? DOWNLOAD_FORMATS : []),
    ]
    const index = available.findIndex((format) => format.id === preferredFormatId)
    if (index <= 0) return available
    const next = available.slice()
    const [preferred] = next.splice(index, 1)
    return [preferred, ...next]
  }, [stencilMode, svgReady, meshReady, preferredFormatId])
  const selectedFormat =
    downloadFormats.find((format) => format.id === preferredFormatId) ?? downloadFormats[0] ?? null
  const downloadDisabled = isGenerating || !selectedFormat

  const exportBar = (
    <>
      {exportError && (
        <div className="rounded-md border border-[var(--text-danger)]/40 bg-[var(--text-danger)]/10 px-3 py-1.5 text-[11px] text-[var(--text-danger)]">
          {exportError}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div ref={formatRef} className="relative shrink-0">
          <div
            className={`flex h-9 overflow-hidden rounded-md text-[12px] ${primaryButtonClass} ${
              downloadDisabled ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <button
              type="button"
              disabled={downloadDisabled}
              onClick={() => selectedFormat && handleDownload(selectedFormat.id)}
              className="flex h-9 items-center gap-1.5 whitespace-nowrap px-4 disabled:cursor-not-allowed"
            >
              {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {isGenerating
                ? 'GENERATING…'
                : `DOWNLOAD${selectedFormat ? ` ${selectedFormat.id.toUpperCase()}` : ''}`}
            </button>
            <button
              type="button"
              disabled={downloadDisabled}
              aria-expanded={formatOpen}
              aria-haspopup="menu"
              aria-label="Choose download format"
              onClick={() => setFormatOpen((open) => !open)}
              className="flex h-9 items-center border-l border-white/30 px-2 disabled:cursor-not-allowed"
            >
              <ChevronDown size={14} className={`transition-transform ${formatOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>
          {formatOpen && !downloadDisabled && (
            <div
              role="menu"
              className="absolute bottom-full left-0 z-20 mb-2 min-w-[12.5rem] overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-card)] py-1 shadow-xl"
            >
              {downloadFormats.map((format) => {
                const selected = format.id === selectedFormat?.id
                const isDefault = format.id === preferredFormatId
                return (
                  <button
                    key={format.id}
                    type="button"
                    role="menuitem"
                    aria-checked={selected}
                    onClick={() => handleDownload(format.id)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] font-medium transition-colors hover:bg-violet-50 hover:text-violet-700 ${
                      selected ? 'bg-violet-50 text-violet-700' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    <span>{format.label}</span>
                    {isDefault ? (
                      <span className="text-[10px] font-semibold tracking-wide text-violet-600">DEFAULT</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <button type="button" onClick={() => setView('landing')} className={FOOTER_BTN}>
          <Upload size={13} />
          UPLOAD A NEW IMAGE
        </button>
        <button type="button" className={FOOTER_BTN}>
          <Link2 size={13} />
          SHARE LINK
        </button>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={savedToLibrary}
          onChange={(e) => handleLibraryToggle(e.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--accent)]"
        />
        ADD DESIGN TO MY LIBRARY
        <Library size={12} />
      </label>
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="contents md:flex md:h-full md:min-h-0 md:w-[320px] md:shrink-0 md:flex-col">
        <MemoSidebar />
        <div className="hidden border-t border-[var(--border)] bg-[var(--bg-sidebar)] px-4 py-2 text-[11px] text-[var(--text-muted)] md:block">
          <span className="truncate">{image?.name ?? 'untitled'}</span>
        </div>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="absolute inset-0 flex min-h-0 flex-col md:static md:inset-auto md:min-h-0 md:flex-1">
        <div
          className={`absolute top-3 z-20 flex gap-2 ${
            workspace === '2d' && !stencilMode ? 'left-[4.5rem]' : 'left-4'
          }`}
        >
          <button
            type="button"
            onClick={() => setWorkspace('3d')}
            className={`rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${
              workspace === '3d'
                ? 'border-[var(--accent)] bg-[var(--bg-header)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-[var(--bg-header)]/80 text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            3D Preview
          </button>
          <button
            type="button"
            onClick={() => setWorkspace('2d')}
            className={`rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${
              workspace === '2d'
                ? 'border-[var(--accent)] bg-[var(--bg-header)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-[var(--bg-header)]/80 text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            2D Editor
          </button>
        </div>

        <div className={workspace === '2d' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <MemoImageEditorView active={workspace === '2d'} showStencil={stencilMode} />
        </div>
        {workspace === '3d' && <Viewer3D />}
        </div>

        {isNarrow && sheetActionsEl
          ? createPortal(
              <div className="flex flex-col items-center gap-2.5 border-b border-[var(--border)] bg-[var(--bg-header)] px-4 py-3">
                {exportBar}
              </div>,
              sheetActionsEl,
            )
          : null}
        {!isNarrow && (
          <div className="flex flex-col items-center gap-2.5 border-t border-[var(--border)] bg-[var(--bg-header)] px-4 py-3">
            {exportBar}
          </div>
        )}
      </div>
    </div>
  )
}