/**
 * Placeholder used when a library thumbnail cannot be loaded.
 * A data URI stays valid under Electron's file:// origin.
 */
export const FALLBACK_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#f3f4f6"/><rect x="118" y="78" width="84" height="68" rx="6" fill="#e5e7eb" stroke="#d1d5db" stroke-width="3"/><circle cx="142" cy="100" r="8" fill="#d1d5db"/><path d="M128 134l16-16 12 12 10-12 22 16H128z" fill="#d1d5db"/></svg>',
  )

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Electron opens the built app with Vite `base: './'`.
 * Root-absolute paths (`/designs/circle.png`) would resolve against the
 * filesystem root. URLs that already have a scheme — http, https, data,
 * blob, or file (Vite's `import.meta.url` asset URLs) — are returned unchanged.
 */
export function resolveMediaSrc(src) {
  if (!src || typeof src !== 'string') return FALLBACK_IMAGE
  const trimmed = src.trim()
  if (!trimmed) return FALLBACK_IMAGE
  if (HAS_SCHEME.test(trimmed) || trimmed.startsWith('//')) return trimmed
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) return trimmed
  const base = import.meta.env.BASE_URL || './'
  return `${base}${trimmed.replace(/^\/+/, '')}`
}

export function applyImageFallback(event) {
  const img = event.currentTarget
  if (!img || img.dataset.fallbackApplied === '1') return
  img.dataset.fallbackApplied = '1'
  img.src = FALLBACK_IMAGE
}
