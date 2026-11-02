import { useCallback, useState } from 'react'
import { Upload } from 'lucide-react'
import { LibraryDesignGrid } from '../components/library/LibraryDesignGrid.jsx'
import { useSettings } from '../context/useSettings.js'

export function LandingView() {
  const { loadImage, useSample } = useSettings()
  const [over, setOver] = useState(false)

  const onFiles = useCallback(
    (files) => {
      const file = files?.[0]
      if (file) loadImage(file)
    },
    [loadImage],
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-app)]">
      <section className="mx-auto max-w-3xl px-6 pb-10 pt-16 text-center">
        <p className="mb-2 text-[12px] font-semibold tracking-[0.2em] text-[var(--accent)]">
          3D COOKIE CUTTER GENERATOR
        </p>
        <h1 className="mb-8 text-4xl font-semibold tracking-tight">Create what's in your imagination</h1>
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
          }}
          className={`mx-auto flex min-h-[220px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-8 py-12 transition ${
            over
              ? 'border-[var(--accent)] bg-[var(--bg-card)]'
              : 'border-[var(--border-strong)] bg-[var(--bg-sidebar)]'
          }`}
        >
          <Upload className="mb-3 text-[var(--accent)]" />
          <p className="text-[15px] font-medium">Drop an image here, or click to upload</p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">PNG, JPG, or SVG. Silhouette contrast works best.</p>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
        </label>
        <button
          type="button"
          onClick={useSample}
          className="mt-5 text-[13px] text-[var(--accent)] underline underline-offset-4"
        >
          Or start with a sample heart silhouette
        </button>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 className="mb-5 text-lg font-semibold">My Library</h2>
        <LibraryDesignGrid />
      </section>
    </div>
  )
}
