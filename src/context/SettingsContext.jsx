import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { computePathsBounds } from '../lib/pathMetrics.js'
import {
  DEFAULT_PROFILE_NAME,
  LIBRARY_STORAGE_KEY,
  PREFERENCES_STORAGE_KEY,
  PROFILES_STORAGE_KEY,
  clampTraceThreshold,
  defaultSettings,
  uid,
} from '../lib/constants.js'
import { parseSvgInWorker, traceImageInWorker } from '../lib/geometryWorkerClient.js'
import { LIBRARY_CUTTER_PROFILE } from '../lib/libraryData.js'
import { PRESET_SHAPES } from '../lib/presets.js'
import { SettingsContext } from './useSettings.js'

const IMAGE_PROCESS_ERROR = 'Failed to process image. Please try a clearer silhouette.'

function reportImageProcessFailure(label, err) {
  console.error(label, err)
  toast.error(IMAGE_PROCESS_ERROR)
}

/** Filled stamp loops only. Open centerlines (role 1) have no area to emboss. */
function filledStampLoops(paths, roles) {
  if (!Array.isArray(paths)) return []
  const kept = []
  for (let i = 0; i < paths.length; i++) {
    const loop = paths[i]
    if (!Array.isArray(loop) || loop.length < 3) continue
    const role = Array.isArray(roles) && roles.length === paths.length ? Number(roles[i]) : 0
    if (role === 1) continue
    let area = 0
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k]
      const b = loop[(k + 1) % loop.length]
      area += a.x * b.y - b.x * a.y
    }
    if (Math.abs(area) < 1e-4) continue
    kept.push(loop)
  }
  return kept
}

function loadLibraryFromStorage() {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const PRINT_FORMATS = new Set(['stl', '3mf', 'obj', 'step'])
const STENCIL_FORMATS = new Set(['svg', 'stl'])

function defaultUserPreferences() {
  return { default3DFormat: 'stl', defaultStencilFormat: 'svg' }
}

function normalizeUserPreferences(raw) {
  const next = defaultUserPreferences()
  if (!raw || typeof raw !== 'object') return next
  if (PRINT_FORMATS.has(raw.default3DFormat)) next.default3DFormat = raw.default3DFormat
  if (STENCIL_FORMATS.has(raw.defaultStencilFormat)) next.defaultStencilFormat = raw.defaultStencilFormat
  return next
}

function loadUserPreferences() {
  if (typeof localStorage === 'undefined') return defaultUserPreferences()
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY)
    return normalizeUserPreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return defaultUserPreferences()
  }
}

function loadProfilesFromStorage() {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (profile) =>
        profile &&
        typeof profile.id === 'string' &&
        typeof profile.name === 'string' &&
        profile.name.trim() &&
        profile.settings &&
        typeof profile.settings === 'object',
    )
  } catch {
    return []
  }
}

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings))
}

const PROFILE_SIZE_KEYS = [
  'width',
  'height',
  'size',
  'longestSide',
  'aspectRatio',
  'designWidth',
  'designHeight',
  'designAspectRatio',
]

function settingsForProfile(settings) {
  const snapshot = cloneSettings(settings)
  for (const key of PROFILE_SIZE_KEYS) delete snapshot[key]
  return snapshot
}

function applyProfileSettings(current, saved) {
  const next = { ...defaultSettings(), ...cloneSettings(saved) }
  next.width = current.width
  next.height = current.height
  next.size = current.size
  next.aspectRatio = current.aspectRatio
  if (current.designWidth != null) next.designWidth = current.designWidth
  if (current.designHeight != null) next.designHeight = current.designHeight
  if (current.designAspectRatio != null) next.designAspectRatio = current.designAspectRatio
  delete next.longestSide
  if (current.longestSide != null) next.longestSide = current.longestSide
  // Profiles saved before stamp artwork existed have no key. Keep the
  // design already on the cutter instead of clearing it with the default.
  if (!Object.prototype.hasOwnProperty.call(saved, 'stampArtworkPaths')) {
    next.stampArtworkPaths = current.stampArtworkPaths ?? null
    next.stampArtworkName = current.stampArtworkName ?? ''
  }
  return next
}

function applyLongestSide(width, height, size) {
  const longest = Math.max(width, height) || 1
  const scale = size / longest
  return { width: width * scale, height: height * scale }
}

const EDITOR_FRAME_PAD = 16
const EDITOR_FRAME_MAX = 1024

/**
 * Move artwork into the tracer's pixel frame (Y up, origin at the top of
 * a blank raster) so `tracePathsToBaseEntities` can turn it into the same
 * editable silhouette a photo trace gets. The 3D fitter only cares about
 * shape, so the translation does not change the cutter.
 */
function frameArtworkForEditor(paths) {
  const bounds = computePathsBounds(paths)
  const spanW = Math.max(bounds.width, 1)
  const spanH = Math.max(bounds.height, 1)
  const longest = Math.max(spanW, spanH)
  const room = EDITOR_FRAME_MAX - EDITOR_FRAME_PAD * 2
  const scale = longest > room ? room / longest : 1
  const width = Math.max(1, Math.ceil(spanW * scale + EDITOR_FRAME_PAD * 2))
  const height = Math.max(1, Math.ceil(spanH * scale + EDITOR_FRAME_PAD * 2))
  const framed = paths.map((loop) =>
    loop.map((point) => {
      const x = (point.x - bounds.minX) * scale + EDITOR_FRAME_PAD
      const yDown = (bounds.maxY - point.y) * scale + EDITOR_FRAME_PAD
      return { x, y: -yDown }
    }),
  )
  return { paths: framed, width, height }
}

function blankFrameUrl(width, height) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas.toDataURL('image/png')
}

export function SettingsProvider({ children }) {
  const [view, setView] = useState('landing')
  const [image, setImage] = useState(null)
  const [settings, setSettings] = useState(defaultSettings)
  const [search, setSearch] = useState('')
  const [profileModified, setProfileModified] = useState(false)
  const [profiles, setProfiles] = useState(loadProfilesFromStorage)
  const [activeProfileName, setActiveProfileName] = useState(DEFAULT_PROFILE_NAME)
  const [rawPaths, setRawPaths] = useState([])
  const [pathRoles, setPathRoles] = useState(null)
  const [activePreset, setActivePreset] = useState(null)
  const [library, setLibrary] = useState(loadLibraryFromStorage)
  const [libraryEntryId, setLibraryEntryId] = useState(null)
  const [isTracing, setIsTracing] = useState(false)
  const [cloudRevision, setCloudRevision] = useState(0)
  const [userPreferences, setUserPreferences] = useState(loadUserPreferences)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  
  const traceGenRef = useRef(0)
  const stampArtGenRef = useRef(0)
  const lastTraceKeyRef = useRef('')
  const tracedUrlRef = useRef('')

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(library))
    } catch {
      // Storage full/unavailable
    }
  }, [library])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles))
    } catch {
      // Storage full/unavailable
    }
  }, [profiles])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(userPreferences))
    } catch {
      // Storage full/unavailable
    }
  }, [userPreferences])

  const markModified = useCallback(() => setProfileModified(true), [])

  const setPreset = useCallback((presetId) => {
    const found = PRESET_SHAPES.find((p) => p.id === presetId)
    if (!found) return
    traceGenRef.current += 1
    const paths = found.getPaths()
    const bounds = computePathsBounds(paths)
    const aspect = (bounds.width || 1) / (bounds.height || 1)

    const framed = frameArtworkForEditor(paths)
    setRawPaths(framed.paths)
    setPathRoles(null)
    setActivePreset(presetId)
    setImage({
      name: `${found.name}.svg`,
      sample: true,
      preset: true,
      isSvg: false,
      url: blankFrameUrl(framed.width, framed.height),
    })
    setLibraryEntryId(null)

    setSettings((prev) => {
      const sized = applyLongestSide(bounds.width || 50, bounds.height || 50, prev.size)
      return {
        ...prev,
        aspectRatio: aspect,
        designAspectRatio: aspect,
        width: sized.width,
        height: sized.height,
        designWidth: sized.width,
        designHeight: sized.height,
      }
    })
    setView('editor')
    markModified()
  }, [markModified])

  const useSample = useCallback(() => {
    setPreset('heart')
  }, [setPreset])

  const loadProductionDesign = useCallback(
    (design) => {
      if (!design?.svg) return
      const gen = ++traceGenRef.current
      parseSvgInWorker(design.svg)
        .then((artwork) => {
          const paths = artwork?.paths
          if (gen !== traceGenRef.current) return
          if (!paths || paths.length === 0) {
            reportImageProcessFailure('[SettingsContext] library SVG produced no paths:', design.name)
            return
          }
          const bounds = computePathsBounds(paths)
          const aspect = (bounds.width || 1) / (bounds.height || 1)
          const presetSize = LIBRARY_CUTTER_PROFILE.size

          const framed = frameArtworkForEditor(paths)
          setRawPaths(framed.paths)
          setPathRoles(artwork.roles)
          setActivePreset(design.id)
          setImage({
            name: `${design.name}.svg`,
            sample: true,
            preset: true,
            isSvg: false,
            url: blankFrameUrl(framed.width, framed.height),
          })
          setLibraryEntryId(null)
          setSettings((prev) => {
            const sized = applyLongestSide(bounds.width || 50, bounds.height || 50, presetSize)
            return {
              ...prev,
              ...LIBRARY_CUTTER_PROFILE,
              size: presetSize,
              aspectRatio: aspect,
              designAspectRatio: aspect,
              width: sized.width,
              height: sized.height,
              designWidth: sized.width,
              designHeight: sized.height,
            }
          })
          setView('editor')
          markModified()
        })
        .catch((err) => {
          if (gen !== traceGenRef.current) return
          reportImageProcessFailure('[SettingsContext] library SVG parse failed:', err)
        })
    },
    [markModified],
  )

  const applyTracedPaths = useCallback((paths, bounds, roles) => {
    const finalPaths = Array.isArray(paths) ? paths : []
    if (finalPaths.length === 0) {
      setRawPaths([])
      setPathRoles(null)
      return
    }
    const finalBounds = bounds ?? computePathsBounds(finalPaths)
    const aspect = (finalBounds.width || 1) / (finalBounds.height || 1)
    const nextRoles = roles && roles.length === finalPaths.length ? roles : null

    setRawPaths(finalPaths)
    setPathRoles(nextRoles)
    setSettings((prev) => {
      const sized = applyLongestSide(finalBounds.width || 50, finalBounds.height || 50, prev.size)
      return {
        ...prev,
        aspectRatio: aspect,
        designAspectRatio: aspect,
        width: sized.width,
        height: sized.height,
        designWidth: sized.width,
        designHeight: sized.height,
      }
    })
  }, [])

  const loadImage = useCallback(
    (file) => {
      if (!file) return
      const isSvg = file.type?.includes('svg') || file.name?.toLowerCase().endsWith('.svg')

      if (isSvg) {
        const gen = ++traceGenRef.current
        file
          .text()
          .then((text) => parseSvgInWorker(text))
          .then((artwork) => {
            const paths = artwork?.paths
            if (gen !== traceGenRef.current) return
            if (!paths || paths.length === 0) throw new Error('No valid paths found in SVG')
            const bounds = computePathsBounds(paths)
            applyTracedPaths(paths, bounds, artwork.roles)
            setActivePreset(null)
            setImage({ url: URL.createObjectURL(file), name: file.name, isSvg: true })
            setLibraryEntryId(null)
            setView('editor')
            markModified()
          })
          .catch((err) => {
            if (gen !== traceGenRef.current) return
            reportImageProcessFailure('[SettingsContext] SVG parse failed:', err)
            applyTracedPaths([])
            setView('editor')
          })
      } else {
        traceGenRef.current += 1
        setRawPaths([])
        createImageBitmap(file)
          .then((bitmap) => {
            bitmap.close?.()
            const url = URL.createObjectURL(file)
            setSettings((prev) => ({
              ...prev,
              imageThreshold: 128,
              imageInvert: false,
            }))
            setActivePreset(null)
            setImage({
              url,
              name: file.name,
              isSvg: false,
              source: file,
            })
            setLibraryEntryId(null)
            setView('editor')
            markModified()
          })
          .catch((err) => {
            reportImageProcessFailure('[SettingsContext] image trace failed:', err)
            applyTracedPaths([])
            setView('editor')
          })
      }
    },
    [applyTracedPaths, markModified],
  )

  useEffect(() => {
    const source = image?.source
    if (!source || image.isSvg) return

    const threshold = clampTraceThreshold(settings.imageThreshold)
    const invert = Boolean(settings.imageInvert)
    const key = `${image.url}|${threshold}|${invert ? 1 : 0}`
    if (lastTraceKeyRef.current === key) {
      setIsTracing(false)
      return
    }

    const gen = ++traceGenRef.current
    const timer = setTimeout(() => {
      const firstForUrl = tracedUrlRef.current !== image.url
      setIsTracing(true)
      createImageBitmap(source)
        .then((bitmap) => {
          if (gen !== traceGenRef.current) {
            bitmap.close?.()
            return { cancelled: true }
          }
          return traceImageInWorker(bitmap, { threshold, invert }).then((paths) => ({ paths }))
        })
        .then((result) => {
          if (!result || result.cancelled || gen !== traceGenRef.current) return
          const paths = result.paths
          lastTraceKeyRef.current = key
          if (!paths?.length) {
            applyTracedPaths([])
            if (firstForUrl) {
              reportImageProcessFailure(
                '[SettingsContext] image trace failed:',
                new Error('No silhouette found'),
              )
            }
            return
          }
          tracedUrlRef.current = image.url
          applyTracedPaths(paths)
        })
        .catch((err) => {
          if (gen !== traceGenRef.current) return
          reportImageProcessFailure('[SettingsContext] image trace failed:', err)
          applyTracedPaths([])
        })
        .finally(() => {
          if (gen === traceGenRef.current) setIsTracing(false)
        })
    }, 50)

    return () => {
      clearTimeout(timer)
      traceGenRef.current += 1
    }
  }, [image, settings.imageThreshold, settings.imageInvert, applyTracedPaths])

  const resetDefaults = useCallback(() => {
    setSettings((prev) => {
      const next = defaultSettings()
      next.unit = prev.unit
      next.aspectRatio = prev.aspectRatio
      const sized = applyLongestSide(prev.width, prev.height, next.size)
      next.width = sized.width
      next.height = sized.height
      return next
    })
    setProfileModified(false)
    setActiveProfileName(DEFAULT_PROFILE_NAME)
  }, [])

  const saveProfile = useCallback(
    (name) => {
      const trimmed = String(name ?? '').trim()
      if (!trimmed || trimmed.toLowerCase() === DEFAULT_PROFILE_NAME.toLowerCase()) return false
      const snapshot = settingsForProfile(settings)
      setProfiles((prev) => {
        const idx = prev.findIndex((profile) => profile.name.toLowerCase() === trimmed.toLowerCase())
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], name: trimmed, settings: snapshot, savedAt: Date.now() }
          return next
        }
        return [...prev, { id: uid(), name: trimmed, settings: snapshot, savedAt: Date.now() }]
      })
      setActiveProfileName(trimmed)
      setProfileModified(false)
      return true
    },
    [settings],
  )

  const loadProfile = useCallback(
    (id) => {
      const entry = profiles.find((profile) => profile.id === id)
      if (!entry) return
      setSettings((current) => applyProfileSettings(current, entry.settings))
      setActiveProfileName(entry.name)
      setProfileModified(false)
    },
    [profiles],
  )

  const deleteProfile = useCallback((id) => {
    const entry = profiles.find((profile) => profile.id === id)
    if (!entry) return false
    setProfiles((prev) => prev.filter((profile) => profile.id !== id))
    if (entry.name === activeProfileName) {
      setActiveProfileName(DEFAULT_PROFILE_NAME)
      setProfileModified(false)
    }
    setCloudRevision((revision) => revision + 1)
    return true
  }, [profiles, activeProfileName])

  const loadStampArtwork = useCallback(
    (file) => {
      if (!file) return
      const isSvg = file.type?.includes('svg') || file.name?.toLowerCase().endsWith('.svg')
      if (!isSvg) {
        toast.error('Stamp design must be an SVG file.')
        return
      }
      const gen = ++stampArtGenRef.current
      file
        .text()
        .then((text) => parseSvgInWorker(text))
        .then((artwork) => {
          if (gen !== stampArtGenRef.current) return
          const paths = filledStampLoops(artwork?.paths, artwork?.roles)
          if (paths.length === 0) {
            reportImageProcessFailure(
              '[SettingsContext] stamp SVG produced no filled paths:',
              new Error(file.name || 'stamp.svg'),
            )
            return
          }
          setSettings((prev) => ({
            ...prev,
            stampArtworkPaths: paths,
            stampArtworkName: file.name || 'stamp.svg',
          }))
          markModified()
        })
        .catch((err) => {
          if (gen !== stampArtGenRef.current) return
          reportImageProcessFailure('[SettingsContext] stamp SVG parse failed:', err)
        })
    },
    [markModified],
  )

  const clearStampArtwork = useCallback(() => {
    stampArtGenRef.current += 1
    setSettings((prev) => ({
      ...prev,
      stampArtworkPaths: null,
      stampArtworkName: '',
    }))
    markModified()
  }, [markModified])

  const patch = useCallback(
    (updater) => {
      setSettings((prev) => (typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }))
      markModified()
    },
    [markModified],
  )

  const setUnit = useCallback((unit) => {
    setSettings((prev) => ({ ...prev, unit }))
  }, [])

  const setSizeMode = useCallback(
    (sizeMode) => {
      setSettings((prev) => ({ ...prev, sizeMode }))
      markModified()
    },
    [markModified],
  )

  const setLongestSize = useCallback(
    (size) => {
      setSettings((prev) => {
        const sized = applyLongestSide(prev.width, prev.height, size)
        return { ...prev, size, width: sized.width, height: sized.height }
      })
      markModified()
    },
    [markModified],
  )

  const setWidth = useCallback(
    (width) => {
      setSettings((prev) => {
        const height = prev.aspectLocked ? width / prev.aspectRatio : prev.height
        const size = Math.max(width, height)
        return { ...prev, width, height, size }
      })
      markModified()
    },
    [markModified],
  )

  const setHeight = useCallback(
    (height) => {
      setSettings((prev) => {
        const width = prev.aspectLocked ? height * prev.aspectRatio : prev.width
        const size = Math.max(width, height)
        return { ...prev, width, height, size }
      })
      markModified()
    },
    [markModified],
  )

  const toggleAspectLock = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      aspectLocked: !prev.aspectLocked,
      aspectRatio: prev.width / (prev.height || 1),
    }))
  }, [])

  const updateUserPreferences = useCallback((partial) => {
    setUserPreferences((prev) => normalizeUserPreferences({ ...prev, ...partial }))
  }, [])

  const openSettingsModal = useCallback(() => setSettingsModalOpen(true), [])
  const closeSettingsModal = useCallback(() => setSettingsModalOpen(false), [])

  const savedToLibrary = useMemo(
    () => libraryEntryId != null && library.some((entry) => entry.id === libraryEntryId),
    [library, libraryEntryId],
  )

  const addToLibrary = useCallback(() => {
    const id = libraryEntryId ?? uid()
    
    // --- خوارزمية التقاط الصورة المصغرة من شاشة الـ 3D ---
    let thumbnail = ''
    try {
      const canvas = document.querySelector('canvas')
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        const size = Math.min(canvas.width, canvas.height)
        const sx = (canvas.width - size) / 2
        const sy = (canvas.height - size) / 2
        
        const offscreen = document.createElement('canvas')
        offscreen.width = 400
        offscreen.height = 400
        const ctx = offscreen.getContext('2d')
        
        // رسم خلفية بيضاء لتكون الصورة واضحة
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, 400, 400)
        
        ctx.drawImage(canvas, sx, sy, size, size, 0, 0, 400, 400)
        thumbnail = offscreen.toDataURL('image/jpeg', 0.8) 
      }
    } catch (err) {
      console.warn('[SettingsContext] Could not capture 3D thumbnail:', err)
    }
    // ----------------------------------------------------

    const entry = {
      id,
      name: image?.name?.replace(/\.(svg|png|jpe?g|webp)$/i, '') || 'Untitled Cutter',
      thingToMake: settings.thingToMake,
      width: settings.width,
      height: settings.height,
      unit: settings.unit,
      thumbnail, // حفظ الصورة هنا!
      settings,
      rawPaths,
      pathRoles,
      savedAt: Date.now(),
    }
    
    setLibrary((prev) => {
      const idx = prev.findIndex((d) => d.id === id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = entry
        return next
      }
      return [entry, ...prev]
    })
    setLibraryEntryId(id)
  }, [image, settings, rawPaths, pathRoles, libraryEntryId])

  const removeFromLibrary = useCallback((id) => {
    setLibrary((prev) => prev.filter((d) => d.id !== id))
    setLibraryEntryId((prev) => (prev === id ? null : prev))
  }, [])

  const removeCurrentFromLibrary = useCallback(() => {
    if (libraryEntryId) removeFromLibrary(libraryEntryId)
  }, [libraryEntryId, removeFromLibrary])

  const loadLibraryDesign = useCallback(
    (id) => {
      const entry = library.find((d) => d.id === id)
      if (!entry) return
      traceGenRef.current += 1
      setRawPaths(entry.rawPaths)
      setPathRoles(entry.pathRoles ?? null)
      setSettings(entry.settings)
      setActivePreset(null)
      setImage({ name: entry.name, sample: false, url: null })
      setLibraryEntryId(entry.id)
      setView('editor')
    },
    [library],
  )

  const applyCloudDesign = useCallback((design) => {
    const saved = design?.settings
    if (!saved || typeof saved !== 'object') return false
    setSettings({ ...defaultSettings(), ...cloneSettings(saved) })
    const name = String(design.name ?? '').trim()
    if (name) setActiveProfileName(name)
    setProfileModified(false)
    setView('editor')
    return true
  }, [])

  const value = useMemo(
    () => ({
      view, setView, image, settings, search, setSearch, profileModified, profiles,
      activeProfileName, saveProfile, loadProfile, deleteProfile, cloudRevision, rawPaths, pathRoles, activePreset,
      setPreset, loadProductionDesign, loadImage, loadStampArtwork, clearStampArtwork,
      isTracing, useSample, resetDefaults, patch, setUnit, setSizeMode, setLongestSize,
      setWidth, setHeight, toggleAspectLock,
      library, savedToLibrary, addToLibrary, removeFromLibrary, removeCurrentFromLibrary,
      loadLibraryDesign, applyCloudDesign,
      userPreferences, updateUserPreferences,
      settingsModalOpen, openSettingsModal, closeSettingsModal,
    }),
    [
      view, image, settings, search, profileModified, profiles, activeProfileName,
      saveProfile, loadProfile, deleteProfile, cloudRevision, rawPaths, pathRoles, activePreset, setPreset,
      loadProductionDesign, loadImage, loadStampArtwork, clearStampArtwork, isTracing,
      useSample, resetDefaults, library,
      savedToLibrary, addToLibrary, removeFromLibrary, removeCurrentFromLibrary,
      loadLibraryDesign, applyCloudDesign, patch, setUnit, setSizeMode, setLongestSize, setWidth,
      setHeight, toggleAspectLock,
      userPreferences, updateUserPreferences, settingsModalOpen, openSettingsModal, closeSettingsModal,
    ],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}