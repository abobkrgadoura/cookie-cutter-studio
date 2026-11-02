import { Sparkles } from 'lucide-react'
import { useSettings } from '../../context/useSettings.js'

export function UpgradeButton() {
  const { setView } = useSettings()

  return (
    <div className="mx-4 mt-4 mb-4 rounded-xl border border-fuchsia-500/20 bg-fuchsia-900/10 p-4">
      <button
        type="button"
        onClick={() => setView('pricing')}
        className="flex w-full items-center justify-center gap-2 rounded-[6px] bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2.5 text-[13px] font-bold tracking-wide text-white shadow-md transition-all hover:from-violet-500 hover:to-fuchsia-500 hover:shadow-lg active:scale-95"
      >
        <Sparkles size={16} />
        UPGRADE TO PRO
      </button>
      <p className="mt-2 text-center text-[10px] text-gray-400">
        Unlock Cloud Library, Wall Text & advanced Cutter types.
      </p>
    </div>
  )
}
