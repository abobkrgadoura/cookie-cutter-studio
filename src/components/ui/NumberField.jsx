import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, HelpCircle } from 'lucide-react'

const TIP_WIDTH = 224
const TIP_GAP = 8

const HOLD_DELAY_MS = 300
const HOLD_INTERVAL_MS = 50

function splitLabelUnit(label, unit) {
  if (!label) return { text: '', unit: unit ?? '' }
  if (unit) return { text: label, unit }
  const match = String(label).match(/^(.*?)\s*\(([^)]+)\)\s*$/)
  if (!match) return { text: label, unit: '' }
  return { text: match[1].trim(), unit: match[2].trim() }
}

function stepPlaces(step) {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

function nudge(value, direction, step, min, max) {
  const places = stepPlaces(step)
  const current = Number.isFinite(Number(value)) ? Number(value) : (min ?? 0)
  let next = Number((current + direction * Number(step)).toFixed(places))
  if (min != null && next < min) next = min
  if (max != null && next > max) next = max
  return next
}

export function FieldHelp({ text }) {
  const anchorRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)

  useLayoutEffect(() => {
    if (!text) return undefined
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const host = anchor.closest('aside') ?? document.documentElement
      const bounds = host.getBoundingClientRect()
      const icon = anchor.getBoundingClientRect()
      const pad = 8
      let left = icon.left
      if (left + TIP_WIDTH > bounds.right - pad) left = bounds.right - pad - TIP_WIDTH
      if (left < bounds.left + pad) left = bounds.left + pad
      const bottom = window.innerHeight - icon.top + TIP_GAP
      setBox((prev) => {
        if (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.bottom - bottom) < 0.5) return prev
        return { left, bottom }
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [text])

  if (!text) return null

  const tip = (
    <div
      role="tooltip"
      style={box ?? { left: -9999, bottom: 0 }}
      className={`pointer-events-none fixed z-[80] w-56 whitespace-normal break-words rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-left text-[11px] font-normal leading-relaxed text-[var(--text-primary)] shadow-lg transition-opacity duration-200 ${
        open && box ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {text}
    </div>
  )

  return (
    <div
      ref={anchorRef}
      className="relative flex shrink-0 items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <HelpCircle
        className="cursor-help text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        size={13}
        aria-label={text}
        tabIndex={0}
      />
      {createPortal(tip, document.body)}
    </div>
  )
}

const spinnerButtonClass =
  'flex flex-1 cursor-pointer items-center justify-center text-violet-600 transition-colors hover:bg-violet-100'

function SpinnerButton({ label, onStep, onEnd, children }) {
  const timersRef = useRef({ timeout: 0, interval: 0 })
  const onStepRef = useRef(onStep)
  const onEndRef = useRef(onEnd)
  onStepRef.current = onStep
  onEndRef.current = onEnd

  const clearHold = () => {
    clearTimeout(timersRef.current.timeout)
    clearInterval(timersRef.current.interval)
    timersRef.current.timeout = 0
    timersRef.current.interval = 0
    onEndRef.current?.()
  }

  useEffect(() => clearHold, [])

  const startHold = (event) => {
    event.preventDefault()
    clearTimeout(timersRef.current.timeout)
    clearInterval(timersRef.current.interval)
    onStepRef.current()
    timersRef.current.timeout = window.setTimeout(() => {
      timersRef.current.interval = window.setInterval(() => onStepRef.current(), HOLD_INTERVAL_MS)
    }, HOLD_DELAY_MS)
  }

  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={startHold}
      onMouseUp={clearHold}
      onMouseLeave={clearHold}
      className={spinnerButtonClass}
    >
      {children}
    </button>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
  unit,
  tooltip,
  className = '',
}) {
  const id = useId()
  const { text, unit: unitText } = splitLabelUnit(label, unit)
  const liveRef = useRef(value)
  const holdingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  const stepRef = useRef(step)
  const minRef = useRef(min)
  const maxRef = useRef(max)

  onChangeRef.current = onChange
  stepRef.current = step
  minRef.current = min
  maxRef.current = max
  if (!holdingRef.current) liveRef.current = value

  const stepBy = (direction) => {
    holdingRef.current = true
    const next = nudge(liveRef.current, direction, stepRef.current, minRef.current, maxRef.current)
    if (next === liveRef.current) return
    liveRef.current = next
    onChangeRef.current(next)
  }

  const endHold = () => {
    holdingRef.current = false
  }

  return (
    <div className={`flex min-w-0 items-center justify-between gap-3 ${className}`}>
      {text ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <label htmlFor={id} className="min-w-0 truncate text-[13px] leading-snug text-[var(--text-primary)]">
            {text}
          </label>
          <FieldHelp text={tooltip} />
        </div>
      ) : null}
      <div className="flex h-8 w-[5.5rem] shrink-0 items-stretch overflow-hidden rounded-[4px] border border-[var(--border)] bg-[var(--bg-input)] focus-within:border-violet-500">
        <input
          id={id}
          type="number"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (Number.isFinite(next)) liveRef.current = next
            onChange(next)
          }}
          aria-label={text || undefined}
          className="min-w-0 flex-1 appearance-none bg-transparent px-2 text-right text-[13px] tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {unitText ? (
          <span className="flex items-center pr-1 text-[11px] text-[var(--text-muted)]">{unitText}</span>
        ) : null}
        <div className="flex w-4 shrink-0 flex-col border-l border-[var(--border)]">
          <SpinnerButton label={text ? `Increase ${text}` : 'Increase'} onStep={() => stepBy(1)} onEnd={endHold}>
            <ChevronUp size={10} strokeWidth={2.5} />
          </SpinnerButton>
          <SpinnerButton label={text ? `Decrease ${text}` : 'Decrease'} onStep={() => stepBy(-1)} onEnd={endHold}>
            <ChevronDown size={10} strokeWidth={2.5} />
          </SpinnerButton>
        </div>
      </div>
    </div>
  )
}

export function TextAreaField({ label, value, onChange, rows = 3 }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {label ? <span className="text-[13px] text-[var(--text-primary)]">{label}</span> : null}
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[72px] w-full resize-y rounded-[4px] border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-1.5 outline-none field-value focus:border-violet-500"
      />
    </div>
  )
}
