import { Search } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../context/useAuth.js'
import { useSettings } from '../../context/useSettings.js'
import { getUserProfile } from '../../lib/dbClient.js'
import { UpgradeButton } from '../ui/UpgradeButton.jsx'
import { BladeSection } from './BladeSection.jsx'
import { CenterBars } from './CenterBars.jsx'
import { CutterWallText } from './CutterWallText.jsx'
import { HandleSection } from './HandleSection.jsx'
import { LightboxSection } from './LightboxSection.jsx'
import { ProfileSection } from './ProfileSection.jsx'
import { SableSection } from './SableSection.jsx'
import { SharpSection } from './SharpSection.jsx'
import { SizeSection } from './SizeSection.jsx'
import { StampSection } from './StampSection.jsx'
import { StencilSection } from './StencilSection.jsx'
import { ThingToMake } from './ThingToMake.jsx'

/** Collapsed sheet always keeps the drag handle and the top 60px on screen. */
const MOBILE_SHEET_PEEK_PX = 60

function visiblePageBottom() {
  const layout = document.documentElement.clientHeight
  const visual = window.visualViewport?.height ?? window.innerHeight
  return Math.min(layout, visual, window.innerHeight)
}

/**
 * Furthest the sheet may move down. Equivalent to `translateY(calc(100% - 60px))`,
 * and never past the visible page, so the handle cannot leave the screen.
 */
function collapsedOffset(sheetHeight, untranslatedTop) {
  const maxDown = Math.max(0, sheetHeight - MOBILE_SHEET_PEEK_PX)
  if (untranslatedTop == null) return maxDown
  const aligned = visiblePageBottom() - MOBILE_SHEET_PEEK_PX - untranslatedTop
  return Math.min(maxDown, Math.max(0, aligned))
}

const SHEET_STOPS = ['collapsed', 'half', 'full']

function useIsMobileSheet() {
  const query = '(max-width: 767px)'
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => setIsMobile(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return isMobile
}

const SECTION_KEYS = {
  size: ['size', 'width', 'height', 'unit', 'longest', 'mirror'],
  blade: ['blade', 'depth', 'thickness'],
  sharp: ['sharp', 'tip', 'chamfer'],
  handle: ['handle', 'round', 'chamfer', 'rectangular'],
  bars: ['center', 'bar', 'solid'],
  text: ['wall', 'text', 'font', 'oswald'],
  stamp: [
    'stamp',
    'back',
    'thickness',
    'clearance',
    'tolerance',
    'imprint',
    'depth',
    'delete',
    'outer',
    'invert',
    'deboss',
    'base',
    'offset',
  ],
  sable: [
    'sable',
    'linzer',
    'bridge',
    'window',
    'chamfer',
    'tip',
    'depth',
    'thickness',
    'hole',
    'inner',
    'flared',
    'cross',
    'line',
    'drawing',
    'fill',
    'pattern',
    'stamp',
    'trim',
    'border',
    'wall',
    'v-shape',
  ],
  stencil: [
    'stencil',
    'board',
    'sheet',
    'design',
    'margin',
    'row',
    'column',
    'grid',
    'bridge',
    'gap',
    'thickness',
    'cut',
    'cameo',
    'repeat',
    'width',
    'height',
    'mirror',
    'size',
  ],
  lightbox: [
    'lightbox',
    'shadow',
    'box',
    'width',
    'height',
    'depth',
    'wall',
    'thickness',
    'battery',
    'aaa',
    'pillar',
    'base',
    'plate',
    'export',
    'download',
    'walls',
  ],
}

export function Sidebar() {
  const { user } = useAuth()
  const { settings, search, setSearch } = useSettings()
  const userId = user?.user?.id ?? null
  const [trackedUserId, setTrackedUserId] = useState(userId)
  // Stay unknown until the profile request finishes. `false` would paint the upgrade CTA.
  const [isPro, setIsPro] = useState(() => (userId == null ? false : undefined))
  const [isLoading, setIsLoading] = useState(() => userId != null)
  const [open, setOpen] = useState({
    blade: true,
    sharp: false,
    handle: false,
    bars: false,
    text: false,
    stamp: true,
    sable: true,
    stencil: true,
    lightbox: true,
  })

  // Blade, Sharp, Handle, and Center Bars belong to the handled cutter.
  // Wall text also wraps the Sablé outer wall. The stamp section shows
  // whenever a stamp is generated. `cutterStamp` shows both groups.
  const showCutterSections = settings.thingToMake === 'cutter' || settings.thingToMake === 'cutterStamp'
  const showStampSection = settings.thingToMake === 'stamp' || settings.thingToMake === 'cutterStamp'
  const showSableSection = settings.thingToMake === 'sable'
  const showStencilSection = settings.thingToMake === 'stencil'
  const showLightboxSection = settings.thingToMake === 'lightbox'
  const showWallText = showCutterSections || showSableSection

  if (userId !== trackedUserId) {
    setTrackedUserId(userId)
    if (userId == null) {
      setIsPro(false)
      setIsLoading(false)
    } else {
      setIsPro(undefined)
      setIsLoading(true)
    }
  }

  useEffect(() => {
    if (!userId) {
      setIsPro(false)
      setIsLoading(false)
      return undefined
    }

    let cancelled = false
    setIsLoading(true)
    setIsPro(undefined)
    getUserProfile()
      .then((profile) => {
        if (!cancelled) setIsPro(profile?.is_pro === true || profile?.plan_tier === 'pro')
      })
      .catch(() => {
        if (!cancelled) setIsPro(false)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const q = search.trim().toLowerCase()
  const show = useMemo(() => {
    if (!q) return () => true
    return (key) => SECTION_KEYS[key].some((w) => w.includes(q) || q.includes(w))
  }, [q])

  const toggle = (key) => setOpen((s) => ({ ...s, [key]: !s[key] }))

  const isMobile = useIsMobileSheet()
  const sheetRef = useRef(null)
  const dragRef = useRef(null)
  const stopRef = useRef('collapsed')
  const offsetRef = useRef(0)
  const [stop, setStop] = useState('collapsed')
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  stopRef.current = stop
  offsetRef.current = offset

  const sheetFrame = useCallback(() => {
    const sheet = sheetRef.current
    const rect = sheet?.getBoundingClientRect()
    const pageBottom = document.documentElement.clientHeight
    const sheetHeight = rect?.height || pageBottom * 0.8
    let applied = offsetRef.current
    if (sheet) {
      const transform = getComputedStyle(sheet).transform
      if (transform && transform !== 'none') {
        applied = new DOMMatrix(transform).m42
      }
    }
    const untranslatedTop = (rect?.top ?? pageBottom - sheetHeight) - applied
    return { sheetHeight, untranslatedTop, pageBottom }
  }, [])

  const offsetFor = useCallback(
    (nextStop) => {
      const { sheetHeight, untranslatedTop, pageBottom } = sheetFrame()
      const floor = collapsedOffset(sheetHeight, untranslatedTop)
      if (nextStop === 'collapsed') return floor
      const visible =
        nextStop === 'full'
          ? sheetHeight
          : Math.min(sheetHeight, Math.max(pageBottom * 0.5, MOBILE_SHEET_PEEK_PX))
      return Math.min(floor, Math.max(0, pageBottom - visible - untranslatedTop))
    },
    [sheetFrame],
  )

  const snapTo = useCallback(
    (nextStop) => {
      setStop(nextStop)
      setOffset(offsetFor(nextStop))
    },
    [offsetFor],
  )

  useLayoutEffect(() => {
    if (!isMobile) return
    setOffset(offsetFor(stop))
  }, [isMobile, stop, offsetFor])

  useEffect(() => {
    if (!isMobile) return undefined
    const onResize = () => setOffset(offsetFor(stopRef.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isMobile, offsetFor])

  const onHandlePointerDown = (event) => {
    if (!isMobile) return
    const frame = sheetFrame()
    const startOffset =
      stopRef.current === 'collapsed'
        ? collapsedOffset(frame.sheetHeight, frame.untranslatedTop)
        : offsetRef.current
    offsetRef.current = startOffset
    setOffset(startOffset)
    dragRef.current = {
      id: event.pointerId,
      startY: event.clientY,
      startOffset,
      startStop: stopRef.current,
      untranslatedTop: frame.untranslatedTop,
      pageBottom: frame.pageBottom,
      sheetHeight: frame.sheetHeight,
      lastY: event.clientY,
      lastT: performance.now(),
      velocity: 0,
      moved: false,
    }
    setDragging(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Capture is unavailable for this pointer. The handle still receives the gesture.
    }
  }

  const onHandlePointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    const dy = event.clientY - drag.startY
    if (Math.abs(dy) > 4) drag.moved = true
    const now = performance.now()
    const dt = now - drag.lastT
    if (dt > 0) drag.velocity = (event.clientY - drag.lastY) / dt
    drag.lastY = event.clientY
    drag.lastT = now
    const next = Math.min(
      Math.max(0, drag.startOffset + dy),
      collapsedOffset(drag.sheetHeight, drag.untranslatedTop),
    )
    offsetRef.current = next
    setOffset(next)
  }

  const onHandlePointerUp = (event) => {
    const drag = dragRef.current
    if (!drag || drag.id !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (!drag.moved) {
      const index = SHEET_STOPS.indexOf(stopRef.current)
      snapTo(SHEET_STOPS[(index + 1) % SHEET_STOPS.length])
      return
    }

    const visible = drag.pageBottom - (drag.untranslatedTop + offsetRef.current)
    const targets = [
      ['collapsed', MOBILE_SHEET_PEEK_PX],
      ['half', drag.pageBottom * 0.5],
      ['full', drag.sheetHeight],
    ]
    const nearest = targets.reduce((best, item) =>
      Math.abs(item[1] - visible) < Math.abs(best[1] - visible) ? item : best,
    )[0]
    const startIndex = Math.max(0, SHEET_STOPS.indexOf(drag.startStop))
    let next = nearest
    if (drag.velocity < -0.35) next = SHEET_STOPS[Math.min(SHEET_STOPS.length - 1, startIndex + 1)]
    else if (drag.velocity > 0.35) next = SHEET_STOPS[Math.max(0, startIndex - 1)]
    snapTo(next)
  }

  const onHandleKeyDown = (event) => {
    if (!isMobile) return
    const index = SHEET_STOPS.indexOf(stop)
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      snapTo(SHEET_STOPS[Math.min(SHEET_STOPS.length - 1, index + 1)])
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      snapTo(SHEET_STOPS[Math.max(0, index - 1)])
    }
  }

  return (
    <aside
      ref={sheetRef}
      data-sheet-stop={isMobile ? stop : undefined}
      className="fixed inset-x-0 bottom-0 z-40 flex h-[80vh] w-full flex-none flex-col rounded-t-2xl border-t border-[var(--border)] bg-[var(--bg-sidebar)] shadow-[0_-12px_40px_rgba(0,0,0,0.28)] md:static md:inset-auto md:z-auto md:h-auto md:min-h-0 md:w-auto md:flex-1 md:rounded-none md:border-r md:border-t-0 md:shadow-none"
      style={
        isMobile
          ? {
              transform: `translateY(${offset}px)`,
              transition: dragging ? 'none' : 'transform 320ms cubic-bezier(0.32, 0.72, 0, 1)',
            }
          : undefined
      }
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label="Settings sheet"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={stop === 'collapsed' ? 0 : stop === 'half' ? 1 : 2}
        aria-valuetext={stop === 'collapsed' ? 'Collapsed' : stop === 'half' ? 'Half open' : 'Expanded'}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onKeyDown={onHandleKeyDown}
        className="flex shrink-0 cursor-grab touch-none select-none flex-col items-center active:cursor-grabbing md:hidden"
      >
        <span aria-hidden="true" className="mt-2 text-[13px] leading-none text-[var(--text-muted)]">
          {stop === 'full' ? '↓' : '↑'}
        </span>
        <span className="w-12 h-1.5 bg-gray-400 rounded-full mx-auto my-2" />
      </div>
      <div id="editor-mobile-actions" className="shrink-0 md:hidden" />
      {!isLoading && isPro === false && <UpgradeButton />}
      <ThingToMake />
      <div className="border-b border-[var(--border)] px-4 py-3">
        <label className="flex items-center gap-2 rounded-[4px] border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-1.5">
          <Search size={14} className="text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-[var(--text-muted)]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <ProfileSection />
        {show('size') && !showStencilSection && !showLightboxSection && <SizeSection />}
        {showStencilSection && show('stencil') && (
          <StencilSection open={open.stencil} onToggle={() => toggle('stencil')} />
        )}
        {showLightboxSection && show('lightbox') && (
          <LightboxSection open={open.lightbox} onToggle={() => toggle('lightbox')} />
        )}
        {showCutterSections && (
          <>
            {show('blade') && <BladeSection open={open.blade} onToggle={() => toggle('blade')} />}
            {show('sharp') && <SharpSection open={open.sharp} onToggle={() => toggle('sharp')} />}
            {show('handle') && <HandleSection open={open.handle} onToggle={() => toggle('handle')} />}
            {show('bars') && <CenterBars open={open.bars} onToggle={() => toggle('bars')} />}
          </>
        )}
        {showSableSection && show('sable') && (
          <SableSection open={open.sable} onToggle={() => toggle('sable')} />
        )}
        {showWallText && show('text') && (
          <CutterWallText open={open.text} onToggle={() => toggle('text')} />
        )}
        {showStampSection && show('stamp') && (
          <StampSection open={open.stamp} onToggle={() => toggle('stamp')} />
        )}
      </div>
    </aside>
  )
}
