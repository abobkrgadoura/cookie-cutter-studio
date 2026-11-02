import { useEffect, useRef, useState } from 'react'

export function isTypingTarget(target) {
  if (!(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || target.isContentEditable) return true
  if (tag === 'INPUT') return true
  if (target.closest('button, a, [role="button"], [role="switch"], [contenteditable="true"]')) return true
  return false
}

export function isPanGesture(event, spaceDown) {
  if (!event) return false
  if (event.button === 1) return true
  return event.button === 0 && Boolean(spaceDown)
}

/** Space is held for "space + left drag" pan. Ignored while typing or on a control. */
export function useSpacePanKey(active) {
  const spaceRef = useRef(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [trackedActive, setTrackedActive] = useState(active)

  if (trackedActive !== active) {
    setTrackedActive(active)
    if (!active) setSpaceDown(false)
  }

  useEffect(() => {
    if (!active) return

    const onKeyDown = (event) => {
      if (event.code !== 'Space' && event.key !== ' ') return
      if (event.repeat) {
        if (spaceRef.current) event.preventDefault()
        return
      }
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      spaceRef.current = true
      setSpaceDown(true)
    }

    const onKeyUp = (event) => {
      if (event.code !== 'Space' && event.key !== ' ') return
      spaceRef.current = false
      setSpaceDown(false)
    }

    const clear = () => {
      spaceRef.current = false
      setSpaceDown(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clear)
      spaceRef.current = false
    }
  }, [active])

  return { spaceRef, spaceDown: active && spaceDown }
}
