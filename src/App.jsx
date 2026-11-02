import { useEffect, useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { UploadCloud } from 'lucide-react'
import { Header } from './components/layout/Header.jsx'
import { AuthModal } from './components/modals/AuthModal.jsx'
import { SettingsModal } from './components/modals/SettingsModal.jsx'
import { useSettings } from './context/useSettings.js'
import { EditorView } from './views/EditorView.jsx'
import { LandingView } from './views/LandingView.jsx'
import { PricingPage } from './views/PricingPage.jsx'

function isTraceableImage(file) {
  if (!file) return false
  const type = file.type ?? ''
  const name = (file.name ?? '').toLowerCase()
  return type.startsWith('image/') || name.endsWith('.svg')
}

function firstTraceableFile(files) {
  if (!files || files.length === 0) return null
  for (const file of files) {
    if (isTraceableImage(file)) return file
  }
  return null
}

function fileFromClipboard(clipboardData) {
  const direct = firstTraceableFile(clipboardData?.files)
  if (direct) return direct

  const items = clipboardData?.items
  if (!items) return null
  for (const item of items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile?.()
    if (isTraceableImage(file)) return file
  }
  return null
}

function dragHasFiles(dataTransfer) {
  const types = dataTransfer?.types
  if (!types) return false
  for (const type of types) {
    if (type === 'Files') return true
  }
  return false
}

export default function App() {
  const { view, loadImage } = useSettings()
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    const onPaste = (e) => {
      const file = fileFromClipboard(e.clipboardData)
      if (!file) return
      e.preventDefault()
      loadImage(file)
    }

    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadImage])

  const onDragOver = (e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  const onDragEnter = (e) => {
    e.preventDefault()
    if (dragHasFiles(e.dataTransfer)) setIsDragging(true)
  }

  const onDragLeave = (e) => {
    e.preventDefault()
    if (e.relatedTarget == null) setIsDragging(false)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    const file = firstTraceableFile(e.dataTransfer?.files)
    if (file) loadImage(file)
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Header />
      {view === 'editor' && <EditorView />}
      {view === 'pricing' && <PricingPage />}
      {view !== 'editor' && view !== 'pricing' && <LandingView />}
      <AuthModal />
      <SettingsModal />
      <Toaster
        position="top-center"
        containerStyle={{ top: 64 }}
        toastOptions={{
          duration: 3500,
          style: {
            background: 'var(--bg-menu)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-strong)',
            borderRadius: '8px',
            fontSize: '13px',
            boxShadow: 'var(--shadow)',
          },
          success: {
            iconTheme: { primary: '#7c3aed', secondary: '#ffffff' },
          },
          error: {
            iconTheme: { primary: '#e07070', secondary: '#ffffff' },
          },
        }}
      />
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-violet-500/20 backdrop-blur-sm transition-all">
          <div className="flex flex-col items-center rounded-xl border-2 border-dashed border-violet-500 bg-[var(--bg-menu)] p-10 shadow-2xl">
            <UploadCloud className="mb-4 text-violet-500" size={48} strokeWidth={1.5} />
            <p className="text-[15px] font-bold tracking-tight text-[var(--text-primary)]">
              Drop image to trace & generate
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
