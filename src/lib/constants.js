import { defaultLightboxSettings } from './presets.js'

/**
 * Plain constants and factory functions shared by `SettingsContext` and the
 * components that read its shape (e.g. `ThingToMake`).
 *
 * These live in their own module — deliberately NOT inside
 * `SettingsContext.jsx` — because Vite's React Fast Refresh only allows a
 * file to keep its HMR boundary (i.e. patch in place without a full page
 * reload) when every export from that file is either a React component or
 * a hook. Mixing plain-object/array constants and factory functions in with
 * `SettingsProvider`/`useSettings` made the whole context module ineligible
 * for Fast Refresh, so any edit anywhere in it forced a full reload (and
 * printed the "export is incompatible" HMR invalidation warning). Isolating
 * the non-component exports here keeps `SettingsContext.jsx` Fast-Refresh
 * clean.
 */

export const DEFAULT_ASPECT = 43.79 / 75

/** Luminance cutoff passed to `traceImageSource`. The slider is 1–254. */
export function clampTraceThreshold(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 128
  return Math.min(254, Math.max(1, Math.round(n)))
}

export function uid() {
  return crypto.randomUUID?.() ?? String(Date.now() + Math.random())
}

export const THING_OPTIONS = [
  { id: 'cutter', label: 'Cutter' },
  { id: 'stamp', label: 'Stamp 👑' },
  { id: 'cutterStamp', label: 'Cutter & Stamp 👑' },
  { id: 'sable', label: 'Sablé / Linzer 👑' },
  { id: 'stencil', label: 'Stencil 👑' },
  { id: 'lightbox', label: 'Shadow Lightbox 💡' },
]

export const LIBRARY_STORAGE_KEY = 'cutterStudio.library.v1'

/** Named cutter-setting presets, separate from saved designs in the library. */
export const PROFILES_STORAGE_KEY = 'cutterStudio.profiles.v1'

/** Account export defaults. Kept off the cutter profile so a design reload cannot reset them. */
export const PREFERENCES_STORAGE_KEY = 'cutterStudio.preferences.v1'

/** Built-in profile label. Not stored in `PROFILES_STORAGE_KEY`. */
export const DEFAULT_PROFILE_NAME = 'Default Settings'

/**
 * Wall Text typeface catalog: each dropdown option maps to a bundled
 * `three-stdlib` typeface JSON basename (see `public/fonts/`), which ships
 * as BOTH a `_regular` and a `_bold` variant — real, distinct glyph files,
 * not a faked/scaled bold — so the "Font Weight" control in
 * `CutterWallText.jsx` has something genuine to switch to. Shared by the
 * UI (dropdown options) and `fontCache.js` (which file to fetch) so the
 * two can never drift out of sync.
 */
export const WALL_TEXT_FONTS = [
  { value: 'Helvetiker', base: 'helvetiker' },
  { value: 'Optimer', base: 'optimer' },
  { value: 'Gentilis', base: 'gentilis' },
  { value: 'Droid Sans', base: 'droid_sans' },
  { value: 'Droid Serif', base: 'droid_serif' },
  { value: 'Staatliches', base: 'staatliches' },
  { value: 'Bellefair', base: 'bellefair' },
  { value: 'Lobster', base: 'lobster' },
  { value: 'Fascinate', base: 'fascinate' },
  { value: 'Abril Fatface', base: 'abril_fatface' },
  { value: 'Joti One', base: 'joti_one' },
]

/** Bundled typeface JSON basename for a Wall Text `font` value, falling
 * back to the first catalog entry for anything unrecognized (e.g. an old
 * saved profile referencing a font that no longer exists). */
export function wallTextFontFileBase(family) {
  return WALL_TEXT_FONTS.find((f) => f.value === family)?.base ?? WALL_TEXT_FONTS[0].base
}

/** One item in the repeatable Wall Text list — mirrors `newBar()`'s shape
 * in `CenterBars.jsx` (a plain factory, not a class) so multiple texts can
 * be independently positioned/sized around the outer wall. */
export function newWallText() {
  return {
    id: uid(),
    text: 'Text',
    font: 'Helvetiker',
    fontWeight: 'normal', // 'normal' | 'bold'
    fontSize: 20,
    textExtrusionDistance: 0.5,
    position: 0,
  }
}

/**
 * A scalable, mostly-FLAT settings object modeled on the shape of a real
 * Cookiecad saved-profile payload (bladeDepth, cutterChamferWidth,
 * handleShape, textExtrusionDistance, ...) rather than deeply-nested
 * per-feature objects. Flat top-level keys for simple scalar knobs; a
 * small nested sub-object only for the self-contained, multi-field
 * "Cutter Wall Text" feature (mirroring how Cookiecad itself keeps things
 * like `customTextSettings` nested) and an array for the repeatable
 * center-bar list. This shape is what gets persisted verbatim in
 * `library` entries (localStorage). The geometry worker is sent
 * `extractGeometryPayload(settings)`, not this whole object.
 */
export const defaultSettings = () => ({
  thingToMake: 'cutter',
  unit: 'mm',
  sizeMode: 'longest',
  size: 75,
  width: 43.79,
  height: 75,
  aspectLocked: true,
  aspectRatio: DEFAULT_ASPECT,
  // Reflect the fitted cavity across X so pressed text reads forward.
  // Negating X flips polygon winding; the fitter restores it.
  mirrorDesign: true,

  // Raster silhouette trace. Applied to the uploaded pixels before the
  // cavity is fit to width/height. SVG and preset paths ignore these.
  imageThreshold: 128,
  imageInvert: false,
  // 2D preview only. Bright white pixels are punched out so the grid
  // shows through. Tracing still uses the original image.
  removeBackground: true,

  // Blade
  bladeDepth: 12.5,
  bladeThickness: 0.8,

  // Sharp cutting edge: the outer wall tapers down to a thin
  // `cutterChamferWidth` cross-section over `cutterChamferHeight` mm.
  sharpCutter: true,
  cutterChamferWidth: 0.4,
  cutterChamferHeight: 2,

  // Press handle
  handleHeight: 3.5,
  handleWidth: 4,
  handleShape: 'rectangular',

  // Structural center bars
  centerBarsEnabled: false,
  centerBars: [{ id: uid(), angle: 0, position: 50, width: 8, height: 10 }],
  centerBarsForceSolid: false,

  // Stamp ("Stamp" / "Cutter & Stamp"): solid backing plate + raised
  // imprint of the traced image's internal detail lines. See
  // `buildStampGeometry` in `lib/cutterGeometry.js`.
  stampBackThickness: 1,
  stampImprintDepth: 4,
  // Signed mm Round offset of the imprint fill. Positive also offsets the
  // plate silhouette by the same delta (no intersection clip). In
  // `cutterStamp` mode the cutter cavity grows by this amount plus
  // `stampClearance` and `stampBaseOffset`. Negative erodes the fill
  // only; the plate stays put.
  stampImprintThickness: 0,
  // Drop the largest loop (a drawn bounding frame) and reverse every
  // remaining loop so former holes become the new outer islands.
  deleteOuterEdge: false,
  // Carve the imprint into the plate instead of raising it.
  // `stampStyle` is the UI source of truth (`emboss` | `deboss`).
  // `invertStamp` stays in sync so older profiles still deboss.
  stampStyle: 'emboss',
  invertStamp: false,
  // Dedicated stamp-face SVG, independent of the cutter silhouette.
  // Loops of `{x,y}` in SVG space. `buildStampGeometry` fits them into
  // the plate. Null means the silhouette fill is the imprint.
  // Packed and transferred beside `rawPaths`; not part of the
  // geometry-number payload (see `extractGeometryPayload`).
  stampArtworkPaths: null,
  stampArtworkName: '',
  // Inset, in mm, applied to both sides of the plate bounding box before
  // the imported stamp SVG is uniformly scaled and centered. See
  // `fitPathsCenteredInBounds`.
  stampArtworkMargin: 2,
  // Extra outward Round offset of the backing plate only, in mm.
  // `cutterStamp` adds the same margin to the blade cavity.
  stampBaseOffset: 0,
  // "Cutter & Stamp" gap, added on top of positive imprint growth.
  // Expands the cutter cavity outward so the stamp still fits loosely
  // inside the blade. Unused outside `cutterStamp` mode.
  stampClearance: 0.9,

  // Sablé / Linzer: one single-wall cutter. The outer wall is full height
  // and sharp at both ends. Each window is a second single wall on the
  // top half only: sharp at the top, flat where it meets the bridge.
  // `sableInnerHole` is the exact longest side of the window group, in mm.
  // Bridges start at mid-height. Line-drawing mode drops the largest hole
  // so a stroked outline presses plain dough. Stamp mode adds a patterned
  // plate. Bridges stay independent, so they can hold a thinned pattern
  // to the walls. Walls stay on the traced outline.
  // `sablePatternThickness` offsets only the stamp paths, which are then
  // clipped to the dough. No trim and no wall offset. See `buildSableGeometry`.
  sableDepth: 21,
  sableThickness: 1.8,
  sableTipWidth: 0.4,
  sableChamfer: 5,
  sableLineDrawingMode: false,
  sableStampMode: false,
  sableStampHeight: 3.0,
  sablePatternThickness: 0,
  sableInnerHole: 30,
  sableBridgesEnabled: true,
  sableBridgeType: 'cross',
  sableBridgeWidth: 4,
  // Full width of a flared or cross-flared bar at its outer ends, in mm.
  // The center stays at `sableBridgeWidth`. Straight bars ignore this.
  sableBridgeFlare: 15,
  sableBridgeDepth: 1.5,

  // Cutter wall text — manifold-extruded glyphs, physically CSG-unioned
  // into the outer wall (see lib/textOnPath.js + lib/cutterGeometry.js).
  // A repeatable list, exactly like `centerBars`
  // above: one shared enable toggle, N independently-configured entries.
  wallTextEnabled: false,
  wallTexts: [newWallText()],

  // Stencil sheet for a cutting plotter. The board is the plastic blank.
  // The design is scaled on its own; cut gap and bridges are absolute mm
  // after that scale. See `buildStencilSheet` in lib/stencilSheet.js.
  stencilBoardWidth: 210,
  stencilBoardHeight: 210,
  stencilMargin: 10,
  designWidth: 80,
  designHeight: 80,
  designAspectLocked: true,
  designAspectRatio: DEFAULT_ASPECT,
  rows: 1,
  columns: 1,
  cutThickness: 1.2,
  stencilArtwork: 'auto',
  stencilBridges: true,
  bridgeWidth: 1.5,
  bridgeCount: 2,
  bridgeStrategy: 'shortest',
  // Manual tabs are drag segments on the 2D sheet, in preview SVG
  // millimetres (origin top-left, Y down): { p1: {x, y}, p2: {x, y} }.
  placement: 'shortest',
  manualBridges: [],

  // Shadow Projection Lightbox. Box size is the outer XY envelope, in mm.
  // Wall thickness, box depth, and the battery pocket are absolute after that.
  // `exportParts` chooses which solids the preview and the download include.
  ...defaultLightboxSettings(),

  // Dimension Overlays
  showDimensions: true,
})
