import { useSettings } from '../../context/useSettings.js'
import { LIBRARY_DESIGNS } from '../../lib/libraryData.js'
import { applyImageFallback, resolveMediaSrc } from '../../lib/mediaSrc.js'

export function LibraryDesignGrid({ onSelect, className = '' }) {
  const { loadProductionDesign } = useSettings()

  return (
    <div className={`grid grid-cols-2 gap-4 md:grid-cols-3 ${className}`}>
      {LIBRARY_DESIGNS.map((design) => (
        <button
          key={design.id}
          type="button"
          onClick={() => {
            loadProductionDesign(design)
            onSelect?.()
          }}
          className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-violet-500 hover:shadow-lg hover:shadow-violet-900/20"
        >
          <div className="h-40 w-full bg-gray-100">
            <img
              src={resolveMediaSrc(design.image)}
              alt={design.name}
              className="h-full w-full rounded-t-lg bg-gray-100 object-cover"
              onError={applyImageFallback}
            />
          </div>
          <div className="px-3 py-2.5">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">{design.name}</div>
            <div className="text-[11px] text-[var(--text-muted)]">Cutter</div>
          </div>
        </button>
      ))}
    </div>
  )
}
