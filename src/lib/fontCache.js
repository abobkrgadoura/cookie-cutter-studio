import { Font } from 'three-stdlib'
import { wallTextFontFileBase } from './constants.js'

// Bundled locally (public/fonts/) so wall-text embossing never depends on a
// live network connection. Each catalog entry in `constants.js` ships both
// a `_regular` and a `_bold` typeface JSON — real, distinct glyph outlines,
// not a faked/scaled bold.
//
// Cached per `(family, weight)` pair — concurrent/repeated callers for the
// same pair share one in-flight fetch instead of re-requesting, and once a
// font has been loaded once it's instant on every subsequent use (e.g.
// switching back and forth between fonts in the dropdown, or re-using the
// same font across multiple wall-text items).
const fontPromises = new Map()

function fontUrl(family, weight) {
  const base = wallTextFontFileBase(family)
  const variant = weight === 'bold' ? 'bold' : 'regular'
  return `/fonts/${base}_${variant}.typeface.json`
}

/** Loads (and caches) a single `three-stdlib` `Font` for the given wall
 * text family + weight. Rejects on failure — callers that need "a font
 * failed to load shouldn't take down every other text" behavior should use
 * `loadFontsForWallTexts` below rather than calling this directly. */
export function loadWallTextFont(family = 'Helvetiker', weight = 'normal') {
  const url = fontUrl(family, weight)
  if (!fontPromises.has(url)) {
    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load font: HTTP ${res.status} (${url})`)
        return res.json()
      })
      .then((json) => new Font(json))
      .catch((err) => {
        fontPromises.delete(url) // allow retry on next call
        throw err
      })
    fontPromises.set(url, promise)
  }
  return fontPromises.get(url)
}

/**
 * Loads every distinct `(font, fontWeight)` pair referenced across a Wall
 * Text list in parallel, returning a `Map` keyed by `${family}::${weight}`
 * -> `Font`. Used by the geometry worker right before generating a model so
 * each text item's manifold glyph extrusion can be built with its OWN selected
 * typeface — this is what makes changing the Font/Font Weight dropdowns
 * actually regenerate the 3D text instead of silently always using
 * whichever font happened to load first.
 *
 * A single bad/missing font file only drops ITS OWN key from the returned
 * map (logged, not thrown) — `buildCutterWallTextGeometry` in
 * `cutterGeometry.js` skips any text item whose font key isn't present
 * rather than failing the whole model.
 */
export async function loadFontsForWallTexts(wallTexts) {
  const keys = new Set()
  for (const item of wallTexts || []) {
    const family = item?.font || 'Helvetiker'
    const weight = item?.fontWeight === 'bold' ? 'bold' : 'normal'
    keys.add(`${family}::${weight}`)
  }

  const map = new Map()
  await Promise.all(
    [...keys].map(async (key) => {
      const [family, weight] = key.split('::')
      try {
        const font = await loadWallTextFont(family, weight)
        map.set(key, font)
      } catch (err) {
        console.error(`[fontCache] failed to load font "${family}" (${weight}):`, err)
      }
    }),
  )
  return map
}
