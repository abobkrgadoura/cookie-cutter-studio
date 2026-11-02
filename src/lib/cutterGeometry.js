import * as THREE from 'three'
import { mergeVertices, toCreasedNormals } from 'three-stdlib'
import {
  booleanDifference,
  booleanIntersection,
  booleanUnion,
  isolateOuterContour,
  robustSimplifyPaths,
} from './clipperWrapper.js'
import {
  extrudeAndUnion,
  extrudeOffsetProfile,
  assembleChamferedBlade,
  buildLightboxParts,
  extrudePaths,
  offsetPathsManifold,
  shellToBladeGeometry,
  unionBufferGeometries,
} from './manifoldEngine.js'
import {
  computePathBounds,
  computePathsBounds,
  computeStampZ,
  enforcePathDimensions,
  fitPathsCenteredInBounds,
  fitPathsToSize,
} from './pathMetrics.js'
import { buildStencilSheet } from './stencilSheet.js'
import { buildStraightBladeShell, buildStraightChamferGeometry } from './straightChamfer.js'
import { buildWallTextGeometry, pickOuterPath } from './textOnPath.js'

export { computeStampZ }

// "Round" handle is a stadium in the RZ plane: flat horizontal shoulders
// flush with the blade wall, circular fillets strictly on the outermost edge.

// "pt"-style UI value -> real-world mm cap height for wall text, kept
// consistent with the scale the previous SDF-text renderer used so
// existing saved profiles still look the same size.
const TEXT_PT_TO_MM = 0.11

// Real-world (mm) cleanup tolerance for stamp fill loops before they
// reach manifold extrusion. 0.01mm is below anything an FDM printer can
// resolve, but is 100x coarser than Clipper's float-noise floor.
const GEOMETRY_CLEAN_TOLERANCE_MM = 0.01

// Position weld for the stamp solid only. Manifold's plate∪imprint boolean
// inserts sliver triangles shorter than 0.0001 mm where the dense imprint
// wall meets the flat backing face. `mergeVertices(..., 1e-4)` quantizes
// those vertices into one cell, collapses the sliver into a line, and the
// averaged vertex normal comes out nearly edge-on (black streaks). 1e-6 mm
// still welds bitwise-equal `getMesh()` duplicates and stays inside
// three-stdlib's int32 hash at cookie-cutter scale (~2 m).
const STAMP_WELD_TOLERANCE_MM = 1e-6

const OFFSET_OPTS = { joinType: 'Round', circularSegments: 128 }

// The bridge is clipped to the dough, then grown this far past the traced
// silhouette so the bar has real volume inside the outer wall. Mid-height
// thickness is `sableThickness` (default 1.8 mm).
const SABLE_BRIDGE_SEAT_MM = 0.05

/** Shoelace signed area. Positive is CCW in the engine's XY plane. */
function loopSignedArea(loop) {
  let area = 0
  const n = loop?.length ?? 0
  for (let i = 0; i < n; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

/**
 * Remove the largest-absolute-area loop (a drawn bounding frame) and
 * reverse every survivor. Reflecting containment parity turns former
 * holes into positive outer islands and their nested details into holes.
 * Copies every point so the caller's path arrays stay intact.
 */
function dropBoundingFrame(paths) {
  if (!paths || paths.length === 0) return []
  let dropIdx = 0
  let bestAbs = -1
  for (let i = 0; i < paths.length; i++) {
    const abs = Math.abs(loopSignedArea(paths[i]))
    if (abs > bestAbs) {
      bestAbs = abs
      dropIdx = i
    }
  }
  const kept = []
  for (let i = 0; i < paths.length; i++) {
    if (i === dropIdx) continue
    const loop = paths[i].map((p) => ({ x: p.x, y: p.y }))
    loop.reverse()
    kept.push(loop)
  }
  return kept
}

/**
 * Reflect every loop across the Y axis. Negating X reverses winding, so
 * each loop is reversed afterwards to keep its original area sign.
 */
function mirrorPathsAcrossX(paths) {
  return paths.map((loop) => {
    const mirrored = loop.map((p) => ({ x: -p.x, y: p.y }))
    mirrored.reverse()
    return mirrored
  })
}

/** Closed loops only. Open centerlines cannot be extruded or differenced. */
function dedicatedStampArtwork(settings) {
  const paths = settings?.stampArtworkPaths
  if (!Array.isArray(paths)) return null
  const closed = []
  for (const loop of paths) {
    if (Array.isArray(loop) && loop.length >= 3) closed.push(loop)
  }
  return closed.length > 0 ? closed : null
}

/**
 * Either flag debosses. The style select writes both together. Profiles
 * saved before `stampStyle` existed only have `invertStamp`.
 */
function stampIsDeboss(settings) {
  return settings?.stampStyle === 'deboss' || settings?.invertStamp === true
}

/**
 * Mirror about the artwork's own vertical center. `mirrorPathsAcrossX`
 * reflects through x = 0, which would slide a design that is not yet
 * sitting on the origin. Reflecting about the bounds center keeps the
 * bounding box put so the later plate-center alignment stays exact.
 */
function mirrorPathsAboutVerticalCenter(paths) {
  const bounds = computePathsBounds(paths)
  if (!Number.isFinite(bounds.cx)) return paths
  return paths.map((loop) => {
    const mirrored = loop.map((p) => ({ x: 2 * bounds.cx - p.x, y: p.y }))
    mirrored.reverse()
    return mirrored
  })
}

/**
 * Fit stamp-face loops into the finished plate.
 * Uniform scale makes the artwork's longest side fit inside the plate
 * bounding box with `stampArtworkMargin` removed from both sides. The
 * scaled bounds are then moved so their center is the plate center.
 * Mirroring follows the cavity so pressed detail reads forward.
 */
function placeStampArtwork(artworkPaths, platePaths, settings) {
  const plate = computePathsBounds(platePaths)
  const margin = Number(settings?.stampArtworkMargin)
  const inset = Number.isFinite(margin) ? Math.max(margin, 0) : 2
  let source = artworkPaths
  if (settings?.mirrorDesign !== false) source = mirrorPathsAboutVerticalCenter(source)
  return fitPathsCenteredInBounds(source, plate, inset)
}

/**
 * Outward Round offset of the cutting cavity via manifold-3d's native
 * `CrossSection.offset`. The inner dough cavity is never modified here —
 * only the OUTER wall is inflated by `deltaMm`.
 *
 * Manifold's offset polygons are returned as-is. A post-offset
 * `robustSimplifyPaths` pass was collapsing dense round-join arcs into
 * uneven, low-poly chords ("mountainous" walls).
 */
function offsetCavity(cavityPaths, deltaMm, overrides = {}) {
  if (!cavityPaths || cavityPaths.length === 0) return []
  if (!(deltaMm > 0.0001)) {
    return cavityPaths.map((loop) => loop.map((p) => ({ x: p.x, y: p.y })))
  }
  const opts = { ...OFFSET_OPTS, ...overrides }
  const offset = offsetPathsManifold(cavityPaths, deltaMm, opts)
  return offset && offset.length > 0 ? offset : []
}

/**
 * Concatenates several BufferGeometries into one. De-indexes every input
 * up front so indexed manifold meshes and non-indexed leftovers concatenate
 * without dropping triangles, then `finalizeGeometry`'s `mergeVertices`
 * re-indexes (and welds) the result.
 */
function mergeBufferGeometries(geometries) {
  const valid = (geometries || []).filter(Boolean)
  if (valid.length === 0) return null

  const flat = valid.map((g) => (g.index ? g.toNonIndexed() : g))
  if (flat.length === 1) return flat[0]

  let totalPositions = 0
  let totalNormals = 0
  for (const g of flat) {
    totalPositions += g.attributes.position.array.length
    if (g.attributes.normal) totalNormals += g.attributes.normal.array.length
  }

  const positions = new Float32Array(totalPositions)
  const normals = new Float32Array(totalNormals)

  let posOffset = 0
  let normOffset = 0

  for (const g of flat) {
    positions.set(g.attributes.position.array, posOffset)
    posOffset += g.attributes.position.array.length

    if (totalNormals > 0) {
      if (g.attributes.normal) {
        normals.set(g.attributes.normal.array, normOffset)
      } else {
        g.computeVertexNormals()
        normals.set(g.attributes.normal.array, normOffset)
      }
      normOffset += g.attributes.position.count * 3
    }
  }

  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (totalNormals > 0) {
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  } else {
    merged.computeVertexNormals()
  }
  return merged
}

/**
 * Physically fuses `addGeo` into `baseGeo` with a real manifold-3d boolean
 * union instead of leaving two coincident/tangent surfaces next to each
 * other. Falls back to a plain merge if the evaluator throws (e.g. the
 * wall-text mesh is not a 2-manifold).
 */
function unionGeometry(baseGeo, addGeo) {
  if (!baseGeo) return addGeo
  if (!addGeo) return baseGeo
  try {
    const geo = unionBufferGeometries(baseGeo, addGeo)
    if (!geo || !geo.attributes.position || geo.attributes.position.count === 0) {
      throw new Error('CSG union produced empty geometry')
    }
    return geo
  } catch (err) {
    console.error('[cutterGeometry] manifold union failed, falling back to plain merge:', err)
    return mergeBufferGeometries([baseGeo, addGeo])
  }
}

/**
 * Welds coincident vertices, then rebuilds smooth vertex normals.
 * Incoming normals are stripped first so `mergeVertices` hashes on
 * position only — hashing normals too leaves coincident CSG verts
 * unwelded and the surface looks faceted.
 *
 * `toCreasedNormals` is applied only for a real crease (angle < 180°).
 * It converts to non-indexed geometry; do NOT call computeVertexNormals
 * afterwards or every triangle becomes flat-shaded.
 *
 * The handle passes 80° so its fillet slices read as one surface. Sablé
 * passes 80° as well: a 7° crease splits the closed-loop seam into a hard
 * edge that slicers lock onto as the Z-seam. A bare blade (no handle)
 * passes 7°: round-join facets are ~2.8° (128 segments) and still blend,
 * while the vertical wall meeting the straight chamfer (~11° at the
 * default 0.4 mm inset over 2 mm) stays a hard edge. Bars / stamp pass
 * 40°. 180° skips `toCreasedNormals`.
 *
 * `weldTolerance` stays 1e-4 mm for the cutter. The stamp passes
 * `STAMP_WELD_TOLERANCE_MM` so the plate-face slivers survive.
 */
function finalizeGeometry(geo, creaseAngleDeg = 180, weldTolerance = 1e-4) {
  if (!geo) return null
  geo.deleteAttribute('normal')
  const welded = mergeVertices(geo, weldTolerance)
  welded.computeVertexNormals()
  if (!(creaseAngleDeg > 0) || creaseAngleDeg >= 180) return welded
  return toCreasedNormals(welded, THREE.MathUtils.degToRad(creaseAngleDeg))
}

/** Translates a geometry so its lowest Z vertex sits exactly at `targetZ`. */
function flushToZ(geo, targetZ = 0) {
  if (!geo) return null
  geo.computeBoundingBox()
  const minZ = geo.boundingBox.min.z
  if (Math.abs(minZ - targetZ) > 1e-6) {
    geo.translate(0, 0, targetZ - minZ)
  }
  return geo
}

/**
 * The Z height, in the FINAL assembled model, at which the blade begins
 * (its flush, flat-thickness base) and the handle ends. Z=0 is always the
 * flat bottom of the handle (the build-plate plane).
 */
function computeBladeBaseZ(settings) {
  return Math.max(settings.handleHeight ?? 0, 0)
}

/**
 * Watertight ring solid: inner wall is the 1:1 traced cavity (vertical),
 * outer wall is a manifold Round offset of that cavity at each `levels`
 * entry. Caps are manifold triangulations.
 */
function buildManifoldRingSolid(
  cavityPaths,
  levels,
  { capAtStart = false, capAtEnd = false, offsetOverrides = {} } = {},
) {
  const cache = new Map()
  const getOuter = (offsetMm) => {
    const key = Math.round(offsetMm * 1000)
    if (!cache.has(key)) cache.set(key, offsetCavity(cavityPaths, offsetMm, offsetOverrides))
    return cache.get(key)
  }
  return extrudeOffsetProfile(cavityPaths, levels, getOuter, { capAtStart, capAtEnd })
}

// The vertical wall extends this far into the chamfer so the boolean union
// has a positive-volume overlap. A coplanar seam (overlap 0) leaves both
// caps in the mesh, and every shared boundary edge is then used by four
// triangles.
const CHAMFER_STACK_OVERLAP_MM = 0.01

/**
 * Builds the complete blade as ONE watertight solid — in its own LOCAL
 * frame, where z=0 is the blade's BASE (flush, full-thickness, where it
 * joins the handle below) and z=totalDepth is the cutting TIP (or the
 * flat top edge, if "Sharp" is off). The caller translates this up by
 * `computeBladeBaseZ`.
 *
 * `basePaths` IS the inner cutting cavity (1:1 with the raw trace). The
 * outer wall is a manifold `CrossSection.offset` by `bladeThickness`
 * (absolute mm after scaling).
 *
 * With Sharp on, the constant-thickness section stays a manifold prism.
 * The sloped tip is a custom straight-line chamfer mesh (one ruled quad
 * strip, not stacked slices), converted through `geometryToManifold` and
 * boolean-unioned onto that prism. Handles are not built here.
 */
export function buildBladeGeometry(basePaths, settings) {
  const thickness = Math.max(settings.bladeThickness, 0.2)
  const totalDepth = Math.max(settings.bladeDepth, 1.0)
  const chamferH = settings.sharpCutter
    ? Math.min(settings.cutterChamferHeight, totalDepth * 0.85)
    : 0
  const tipWidth = settings.sharpCutter
    ? Math.max(Math.min(settings.cutterChamferWidth, thickness * 0.9), 0.05)
    : thickness
  const mainDepth = Math.max(totalDepth - chamferH, 0.2)

  // The blade is always a closed solid. Its bottom cap stays on even when a
  // handle is present; generateFullCutterModel boolean-unions the two shells
  // so the shared face is interior instead of an open overlapping sheet.
  const cap = { capAtStart: true, capAtEnd: true }

  if (!(chamferH > 0.02) || !(thickness - tipWidth > 0.02)) {
    return buildManifoldRingSolid(
      basePaths,
      [
        { z: 0, offset: thickness },
        { z: totalDepth, offset: thickness },
      ],
      cap,
    )
  }

  const legacyStacked = () =>
    buildManifoldRingSolid(
      basePaths,
      [
        { z: 0, offset: thickness },
        { z: mainDepth, offset: thickness },
        { z: totalDepth, offset: tipWidth },
      ],
      cap,
    )

  const bottomLoop = pickOuterPath(offsetCavity(basePaths, thickness))
  const topLoop = pickOuterPath(offsetCavity(basePaths, tipWidth))
  const cavityLoop = pickOuterPath(basePaths)
  const radialGap = thickness - tipWidth
  if (bottomLoop && topLoop && cavityLoop && basePaths.length === 1) {
    const shell = buildStraightBladeShell({
      bottomLoop,
      topLoop,
      cavityLoop,
      zBase: 0,
      zSeam: mainDepth,
      zTip: totalDepth,
      radialGap,
    })
    if (shell) {
      const solidified = shellToBladeGeometry(shell)
      shell.dispose()
      if (solidified && solidified.attributes?.position?.count) return solidified
    }
  }

  const chamfer = bottomLoop && topLoop
    ? buildStraightChamferGeometry(bottomLoop, topLoop, mainDepth, totalDepth, { radialGap })
    : null

  if (!bottomLoop || !chamfer) {
    chamfer?.dispose()
    console.warn('[cutterGeometry] straight chamfer unavailable, using stacked prism blade')
    return legacyStacked()
  }

  const verticalHeight = Math.min(mainDepth + CHAMFER_STACK_OVERLAP_MM, totalDepth - 0.05)
  const fused = assembleChamferedBlade({
    cavityPaths: basePaths,
    verticalOuterPaths: [bottomLoop],
    verticalHeight,
    chamferGeo: chamfer,
    chamferZ0: mainDepth,
    chamferZ1: totalDepth,
  })
  chamfer.dispose()
  if (!fused || !fused.attributes?.position || fused.attributes.position.count === 0) {
    console.warn('[cutterGeometry] straight chamfer union failed, using stacked prism blade')
    return legacyStacked()
  }
  return fused
}

/**
 * Builds the handle: sits BELOW the blade in the final assembly, its own
 * flat bottom at z=0. Inner wall stays flush with the blade's inner
 * cavity. Outer wall is a manifold Round offset whose distance from the
 * cavity follows the Rectangular / Chamfer / Round profile.
 */
export function buildHandleGeometry(basePaths, settings) {
  if (!settings.handleHeight || settings.handleHeight <= 0.1 || settings.handleWidth <= 0.1) {
    return null
  }

  const bladeThickness = Math.max(settings.bladeThickness, 0.2)
  const handleWidth = Math.max(settings.handleWidth, 0.2)
  const handleHeight = Math.max(settings.handleHeight, 0.2)
  const shape = settings.handleShape ?? 'rectangular'
  const bladeOuter = bladeThickness
  const handleOuter = bladeThickness + handleWidth

  let levels

  if (shape === 'round') {
    // Rectangular grip with quarter-circle fillets on the outer corners only.
    // 8 cosine samples/arc. Task 2.2 will mark these `interpolation: 'arc'`
    // so densifyOffsetLevels cannot linearly chord-subdivide the fillet.
    const filletRadius = Math.min(handleWidth / 1.9, handleHeight / 1.9)
    const rFlat = handleOuter - filletRadius
    const STEPS = 8
    const halfPi = Math.PI / 2
    levels = [{ z: 0, offset: rFlat }]

    for (let s = 1; s <= STEPS; s++) {
      const theta = (s / STEPS) * halfPi
      levels.push({
        z: filletRadius * (1 - Math.cos(theta)),
        offset: rFlat + filletRadius * Math.sin(theta),
      })
    }

    if (handleHeight > 2 * filletRadius) {
      levels.push({ z: handleHeight - filletRadius, offset: handleOuter })
    }

    for (let s = 1; s <= STEPS; s++) {
      const theta = (s / STEPS) * halfPi
      levels.push({
        z: handleHeight - filletRadius + filletRadius * Math.sin(theta),
        offset: rFlat + filletRadius * Math.cos(theta),
      })
    }

    levels.push({ z: handleHeight, offset: bladeOuter })
  } else if (shape === 'chamfer') {
    const filletRadius = Math.min(handleHeight * 0.55, handleWidth * 1.4, handleHeight - 0.1)
    const straightHeight = Math.max(handleHeight - filletRadius, 0.1)

    // Try flawless ray-cast straight shell for single-loop cavities
    if (basePaths.length === 1) {
      const bottomLoop = pickOuterPath(offsetCavity(basePaths, handleOuter))
      const topLoop = pickOuterPath(offsetCavity(basePaths, bladeOuter))
      const cavityLoop = pickOuterPath(basePaths)
      const radialGap = handleOuter - bladeOuter

      if (bottomLoop && topLoop && cavityLoop) {
        const shell = buildStraightBladeShell({
          bottomLoop,
          topLoop,
          cavityLoop,
          zBase: 0,
          zSeam: straightHeight,
          zTip: handleHeight,
          radialGap,
        })
        if (shell) {
          const solidified = shellToBladeGeometry(shell)
          shell.dispose()
          if (solidified && solidified.attributes?.position?.count) {
            return solidified
          }
        }
      }
    }

    // Fallback for multi-loop cavities (densified sweep)
    levels = [
      { z: 0, offset: handleOuter },
      { z: straightHeight, offset: handleOuter },
    ]
    const CHAMFER_STEPS = 16
    for (let i = 1; i <= CHAMFER_STEPS; i++) {
      const t = i / CHAMFER_STEPS
      levels.push({
        z: straightHeight + t * (handleHeight - straightHeight),
        offset: handleOuter + t * (bladeOuter - handleOuter),
      })
    }
  } else {
    // Rectangular: perfect vertical 90° block in Z, then a same-Z inward
    // shoulder onto the blade wall. No Z-fillets or chamfers.
    // XY perimeter stays the default JoinType.Round (OFFSET_OPTS) so
    // outer corners remain filleted — do not pass a Miter override.
    levels = [
      { z: 0, offset: handleOuter },
      { z: handleHeight, offset: handleOuter },
      { z: handleHeight, offset: bladeOuter },
    ]
  }

  // Native levels now include the rectangular inward shoulder, so keep the
  // manifold top cap. Stripping it (capAtEnd: false) plus triangulateRingCap
  // was what deformed the rectangle and left round/chamfer joins open.
  // No per-shape offsetOverrides: all handles inherit JoinType.Round.
  return buildManifoldRingSolid(basePaths, levels, {
    capAtStart: true,
    capAtEnd: true,
  })
}

/**
 * Builds center structural reinforcement bars that brace the cutting
 * profile itself. Each bar is a manifold extrusion of the bar rectangle
 * clipped to the cavity, sitting flush on the build plate.
 */
export function buildCenterBarsGeometry(basePaths, settings) {
  if (!settings.centerBarsEnabled || !settings.centerBars || settings.centerBars.length === 0) {
    return null
  }

  const bounds = computePathsBounds(basePaths)
  const span = Math.hypot(bounds.width, bounds.height) * 1.5
  const forcedFullDepth = Math.max(settings.handleHeight ?? 0, 0) + Math.max(settings.bladeDepth, 1.0)

  const barGeometries = []

  for (const bar of settings.centerBars) {
    const barWidth = Math.max(bar.width, 0.5)
    const barDepth = settings.centerBarsForceSolid
      ? forcedFullDepth
      : Math.max(bar.height ?? (settings.handleHeight ?? 3.5) * 1.2, 0.5)
    const angleRad = THREE.MathUtils.degToRad(bar.angle || 0)
    const t = (bar.position ?? 50) / 100
    const centerY = bounds.minY + bounds.height * t
    const centerX = bounds.cx

    const hw = span / 2
    const hh = barWidth / 2
    const rect = [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ]

    const cos = Math.cos(angleRad)
    const sin = Math.sin(angleRad)
    const rotatedBar = rect.map((p) => ({
      x: centerX + (p.x * cos - p.y * sin),
      y: centerY + (p.x * sin + p.y * cos),
    }))

    const clippedBar = booleanIntersection(basePaths, [rotatedBar])
    if (clippedBar && clippedBar.length > 0) {
      const geo = extrudePaths(clippedBar, barDepth)
      if (geo) barGeometries.push(geo)
    }
  }

  return flushToZ(mergeBufferGeometries(barGeometries), 0)
}

/**
 * Builds the "Stamp" solid: a flat backing plate with a raised imprint of
 * the traced image's real ink standing up off its top face.
 *
 * Both pieces are manifold extrusions of the 2D fill (plate = outermost
 * silhouette only; imprint = nonzero-fill of the ink paths), fused with
 * one `extrudeAndUnion` boolean so the stamp is a single watertight solid.
 * A nonzero `stampImprintThickness` offsets the ink fill with a round join.
 * When the stamp is embossed, a positive value also offsets the plate
 * silhouette by the same delta, so the plate boundary and the imprint's
 * outer wall meet at a pure 90° vertical seam. Do not clip that offset
 * with `booleanIntersection`: the clip inserts microscopic sloped slivers
 * under the 40° crease threshold, and area-weighted normals then drag the
 * flat backing face toward the tall imprint walls. A negative value erodes
 * the fill only — the plate stays at the traced silhouette. Deboss mode
 * does not apply that imprint growth to the plate; only `stampBaseOffset`
 * expands it. Deboss subtracts the imprint from the plate in 2D with
 * Clipper `booleanDifference` (no extra WASM handles), then both solids
 * are extruded and fused with `extrudeAndUnion`. The full plate is the
 * cavity floor. The difference is the raised field, so the design is an
 * engraved pocket of depth `stampImprintDepth`. When the plate has not
 * been grown, it is eroded 0.05 mm first so the difference does not share
 * a coincident perimeter. Dedicated `stampArtworkPaths` replace that fill:
 * they are fitted into the plate, embossed by extruding them up through
 * the plate's top face (positive Z overlap), or debossed by the same
 * difference. The raised face starts a hair below the plate's top face so
 * the two volumes overlap and fuse — coplanar caps at `backThickness`
 * would otherwise z-fight. CrossSection and Manifold handles stay inside
 * `offsetPathsManifold` / `extrudeAndUnion`, which delete them on every exit.
 * `deleteOuterEdge` drops the largest loop and reverses the rest before
 * the silhouette is isolated, so a drawn bounding frame is not the plate.
 * `stampClearance` is not applied here. In `cutterStamp` mode the cutter
 * cavity absorbs positive plate growth (see `generateFullCutterModel`).
 */
export function buildStampGeometry(basePaths, settings) {
  if (
    settings.thingToMake !== 'stamp' &&
    settings.thingToMake !== 'cutterStamp' &&
    settings.thingToMake !== 'practice'
  ) {
    return null
  }

  const backThickness = Math.max(settings.stampBackThickness ?? 1, 0.4)
  const imprintDepth = Math.max(settings.stampImprintDepth ?? 4, 0.2)
  const stampZOverlap = 0.05

  let stampPaths = basePaths
  if (settings.deleteOuterEdge) {
    stampPaths = dropBoundingFrame(basePaths)
    if (!stampPaths || stampPaths.length === 0) return null
  }

  const outerSilhouette = isolateOuterContour(stampPaths)
  if (!outerSilhouette || outerSilhouette.length === 0) return null

  const deboss = stampIsDeboss(settings)
  const artwork = dedicatedStampArtwork(settings)
  const imprintThickness = settings.stampImprintThickness || 0
  const baseOffset = Math.max(Number(settings.stampBaseOffset) || 0, 0)

  // Silhouette emboss grows the plate with the imprint so the outer walls
  // meet at 90°. Deboss does not. Dedicated artwork is an interior design,
  // so thickening it must not move the plate edge either — only
  // `stampBaseOffset` does. The plate is finished before the artwork is
  // scaled, so the margin is measured against the plate the user sees.
  const effectiveImprintGrowth = deboss || artwork ? 0 : Math.max(imprintThickness, 0)
  const plateGrowth = effectiveImprintGrowth + baseOffset

  let processedSilhouette = outerSilhouette
  if (plateGrowth > 0.0001) {
    const grownPlate = offsetPathsManifold(outerSilhouette, plateGrowth, { joinType: 'Round' })
    if (!grownPlate || grownPlate.length === 0) return null
    processedSilhouette = grownPlate
  }

  const platePaths = robustSimplifyPaths(processedSilhouette, GEOMETRY_CLEAN_TOLERANCE_MM)
  if (!platePaths || platePaths.length === 0) return null

  let processedPaths = stampPaths
  const useArtwork = Boolean(artwork)
  if (useArtwork) {
    const placed = placeStampArtwork(artwork, platePaths, settings)
    if (!placed || placed.length === 0) return null
    processedPaths = placed
  }

  if (Math.abs(imprintThickness) > 0.001) {
    const thickened = offsetPathsManifold(processedPaths, imprintThickness, { joinType: 'Round' })
    if (thickened && thickened.length > 0) processedPaths = thickened
  }

  const cleanedImprint = robustSimplifyPaths(processedPaths, GEOMETRY_CLEAN_TOLERANCE_MM)
  let imprintPaths = cleanedImprint
  if (useArtwork) {
    // Safety clip only. The margin fit already keeps the design inside
    // the plate bounds; this drops any sliver a later thickness offset
    // pushed past a concave outline. Clipper only — no WASM handles.
    const clipped = booleanIntersection(platePaths, cleanedImprint)
    imprintPaths = clipped && clipped.length > 0 ? clipped : cleanedImprint
  }
  imprintPaths = booleanUnion(imprintPaths, null)
  if (useArtwork && (!imprintPaths || imprintPaths.length === 0)) return null

  let topPaths = imprintPaths

  // Deboss is a 2D subtract of the design from the plate, then a raised
  // extrusion of what remains. The plate solid underneath is the floor of
  // the engraved cavity. A 3D extrude-and-difference left non-manifold
  // seams here; Clipper's booleanDifference does not allocate WASM.
  if (deboss) {
    if (!imprintPaths || imprintPaths.length === 0) return null
    let targetPlate = platePaths
    if (!useArtwork && baseOffset < 0.01 && imprintThickness <= 0) {
      const eroded = offsetPathsManifold(platePaths, -0.05, { joinType: 'Round' })
      if (eroded && eroded.length > 0) targetPlate = eroded
    }
    topPaths = booleanDifference(targetPlate, imprintPaths)
    if (!topPaths || topPaths.length === 0) return null
  }

  return extrudeAndUnion(
    [
      { paths: platePaths, height: backThickness, z0: 0 },
      {
        paths: topPaths,
        height: imprintDepth + stampZOverlap,
        z0: backThickness - stampZOverlap,
      },
    ],
    { weldTolerance: STAMP_WELD_TOLERANCE_MM },
  )
}

/** Typical Mylar stencil sheet. The board stays centered on the origin. */
const STENCIL_THICKNESS_MM = 0.5

/**
 * Cap vertices of an extrusion are the same vertices as the vertical wall.
 * Area-weighted `computeVertexNormals` then tilts the flat face toward the
 * wall wherever the cap triangle is thin, which reads as wrinkles.
 * Duplicate those vertices so the top and bottom faces keep a pure ±Z
 * normal and the wall keeps its own smooth normal.
 */
function separateSheetCapNormals(geo) {
  if (!geo?.attributes?.position || !geo.index) return geo
  const pos = geo.attributes.position
  const srcIndex = geo.index.array
  const triCount = srcIndex.length / 3
  if (triCount < 1 || pos.count < 3) return geo

  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const zEps = 1e-3
  const kind = new Uint8Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const i0 = srcIndex[t * 3]
    const i1 = srcIndex[t * 3 + 1]
    const i2 = srcIndex[t * 3 + 2]
    const z0 = pos.getZ(i0)
    const z1 = pos.getZ(i1)
    const z2 = pos.getZ(i2)
    if (Math.abs(z0 - maxZ) < zEps && Math.abs(z1 - maxZ) < zEps && Math.abs(z2 - maxZ) < zEps) kind[t] = 1
    else if (Math.abs(z0 - minZ) < zEps && Math.abs(z1 - minZ) < zEps && Math.abs(z2 - minZ) < zEps) kind[t] = 2
  }

  const used = new Uint8Array(pos.count)
  for (let t = 0; t < triCount; t++) {
    const bit = kind[t] === 1 ? 1 : kind[t] === 2 ? 2 : 4
    used[srcIndex[t * 3]] |= bit
    used[srcIndex[t * 3 + 1]] |= bit
    used[srcIndex[t * 3 + 2]] |= bit
  }

  const topCopy = new Int32Array(pos.count)
  const botCopy = new Int32Array(pos.count)
  topCopy.fill(-1)
  botCopy.fill(-1)
  const extras = []
  for (let i = 0; i < pos.count; i++) {
    const flags = used[i]
    const hasTop = flags & 1
    const hasBot = flags & 2
    const hasWall = flags & 4
    if (hasTop && (hasWall || hasBot)) {
      topCopy[i] = pos.count + extras.length
      extras.push(i)
    }
    if (hasBot && (hasWall || hasTop)) {
      botCopy[i] = pos.count + extras.length
      extras.push(i)
    }
  }

  const newCount = pos.count + extras.length
  const positions = new Float32Array(newCount * 3)
  positions.set(pos.array)
  for (let e = 0; e < extras.length; e++) {
    const s = extras[e] * 3
    const d = (pos.count + e) * 3
    positions[d] = pos.array[s]
    positions[d + 1] = pos.array[s + 1]
    positions[d + 2] = pos.array[s + 2]
  }

  const newIndex = new Uint32Array(srcIndex.length)
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = srcIndex[t * 3 + k]
      let next = v
      if (kind[t] === 1 && topCopy[v] >= 0) next = topCopy[v]
      else if (kind[t] === 2 && botCopy[v] >= 0) next = botCopy[v]
      newIndex[t * 3 + k] = next
    }
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(newIndex, 1))
  geo.deleteAttribute('normal')
  geo.computeVertexNormals()

  const normal = geo.attributes.normal
  for (let i = 0; i < pos.count; i++) {
    const flags = used[i]
    const topOnly = (flags & 1) && !(flags & 2) && !(flags & 4)
    const botOnly = (flags & 2) && !(flags & 1) && !(flags & 4)
    if (topCopy[i] >= 0) normal.setXYZ(topCopy[i], 0, 0, 1)
    else if (topOnly) normal.setXYZ(i, 0, 0, 1)
    if (botCopy[i] >= 0) normal.setXYZ(botCopy[i], 0, 0, -1)
    else if (botOnly) normal.setXYZ(i, 0, 0, -1)
  }
  normal.needsUpdate = true
  return geo
}

/**
 * Solid stencil blank. `buildStencilSheet` already resolves the board,
 * cutouts, and bridges into one Clipper region. Extrude that, weld it,
 * then split the flat caps off the walls so the sheet stays smooth.
 */
function finalizeStencilSurface(geo) {
  if (!geo) return null
  return separateSheetCapNormals(finalizeGeometry(geo, 180, 1e-4))
}

export function buildStencilGeometry(basePaths, settings, roles = null) {
  if (settings?.thingToMake !== 'stencil') return null
  const sheet = buildStencilSheet(basePaths, settings, roles)
  const geo = extrudePaths(sheet?.plasticPaths, STENCIL_THICKNESS_MM)
  return finalizeStencilSurface(geo)
}

/**
 * Worker entry for the stencil product. Returns the finalized sheet plus
 * the cut contours the SVG preview and Cameo export use.
 */
export function buildStencilModel(sourcePaths, settings, roles = null, drawings = null, replaceBase = false) {
  const sheet = buildStencilSheet(sourcePaths, settings, roles, drawings, replaceBase)
  const geo = extrudePaths(sheet?.plasticPaths, STENCIL_THICKNESS_MM)
  return { geometry: finalizeStencilSurface(geo), sheet }
}

/**
 * Builds the volumetric cutter-wall text: manifold-extruded glyphs bent
 * around the outer wall and embossed outward from it.
 */
export function buildCutterWallTextGeometry(basePaths, settings, fontsByKey) {
  if (
    !settings.wallTextEnabled ||
    !settings.wallTexts ||
    settings.wallTexts.length === 0 ||
    !fontsByKey ||
    fontsByKey.size === 0
  ) {
    return null
  }

  const cavity = pickOuterPath(basePaths)
  if (!cavity) return null

  const bladeThickness = Math.max(settings.bladeThickness, 0.2)
  const outer = pickOuterPath(offsetCavity([cavity], bladeThickness))
  if (!outer) return null

  const totalDepth = Math.max(settings.bladeDepth, 1.0)
  const chamferH = settings.sharpCutter
    ? Math.min(settings.cutterChamferHeight, totalDepth * 0.85)
    : 0
  const mainDepth = Math.max(totalDepth - chamferH, 0.2)
  const z = computeBladeBaseZ(settings) + mainDepth / 2
  const embedDepth = Math.min(0.4, bladeThickness * 0.4)

  const pieces = []
  for (const item of settings.wallTexts) {
    if (!item?.text?.trim()) continue
    const family = item.font || 'Helvetiker'
    const weight = item.fontWeight === 'bold' ? 'bold' : 'normal'
    const font = fontsByKey.get(`${family}::${weight}`)
    if (!font) continue
    const geo = buildWallTextGeometry(outer, item.text, font, {
      fontSize: Math.max((item.fontSize ?? 20) * TEXT_PT_TO_MM, 0.6),
      extrusionDepth: Math.max(item.textExtrusionDistance ?? 0.5, 0.15),
      startFraction: (item.position ?? 0) / 100,
      lineDistance: item.lineDistance ?? 1.5,
      letterSpacing: item.letterSpacing ?? 0,
      curveSegments: item.curveSegments ?? 24,
      z,
      embedDepth,
    })
    if (geo) pieces.push(geo)
  }

  if (pieces.length === 0) return null
  return mergeBufferGeometries(pieces)
}

/**
 * Double-sided Sablé / Linzer cutter.
 *
 * `basePaths` is the fitted dough. A NonZero union re-orients every loop
 * before classification, because mirroring across X can flip winding and
 * swap the outer wall with the windows. Positive loops are the outer
 * cutters: one single wall over `[0, depth]`, sharp at both ends. Windows
 * are scaled together about the group's center until the group's longest
 * side is `sableInnerHole` mm, reversed to CCW solids, and built as a
 * second single wall over `[midZ, depth]` — sharp at `depth`, flat at
 * `midZ`. Every half is `buildStraightBladeShell` (ray-cast chamfer, no
 * loft). That loop is the vertical cutting face. Wall thickness grows
 * outward into the dough. These faces are the traced outline. Pattern
 * thickness never moves them.
 *
 * Line-drawing mode keeps only the largest outer and drops the largest
 * hole, so a stroked outline presses plain dough and the remaining
 * windows stay cutters. Stamp mode keeps the largest outer and the hole
 * nearest the design center, and adds a plate. Bridges are a separate
 * solid, so they can run with that plate and hold a thinned pattern to
 * the walls. `sablePatternThickness` offsets only the stamp paths. That
 * plate is then clipped to the dough: inside the outer wall, outside the
 * scaled window. Nothing is unioned back onto the cutting faces.
 *
 * Bridges are clipped to the dough after the windows are scaled, so the
 * bar meets the cutters that were actually built. They occupy that dough
 * plus a 0.05 mm seat inside the walls, and are extruded from `midZ`.
 */
export function buildSableGeometry(basePaths, settings) {
  if (settings.thingToMake !== 'sable' || !basePaths || basePaths.length === 0) return null

  const depth = Math.max(Number(settings.sableDepth) || 21, 2)
  const thickness = Math.max(Number(settings.sableThickness) || 1.8, 0.4)
  // The lip stays inside the wall. A tip wider than the wall inverts the chamfer.
  const tipWidth = Math.min(
    Math.max(Number(settings.sableTipWidth) || 0.4, 0.1),
    Math.max(thickness - 0.05, 0.1),
  )
  const midZ = depth / 2
  // The shell needs a vertical run and a slope, each taller than 0.02 mm.
  // Cap just inside half the depth so the outer bottom half still has one.
  const chamferInput = Number(settings.sableChamfer)
  const chamfer = Math.min(
    Math.max(Number.isFinite(chamferInput) ? chamferInput : 5, 0.05),
    Math.max(midZ - 0.05, 0.05),
  )
  const bDepth = Math.max(Number(settings.sableBridgeDepth) || 1.5, 0.5)

  // Insert points on edges longer than `maxDist`. Collinear only — the
  // cutting profile does not move. 0.5 mm on the source loops, 0.2 mm on
  // the offset loops the ray-caster pairs, so a seam clamp stays microscopic.
  const densify = (loop, maxDist) => {
    if (!loop || loop.length < 3) return loop
    const out = []
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]
      const b = loop[(i + 1) % loop.length]
      out.push(a)
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len > maxDist) {
        const steps = Math.ceil(len / maxDist)
        for (let s = 1; s < steps; s++) {
          const t = s / steps
          out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
        }
      }
    }
    return out
  }

  // Clipper's NonZero union emits CCW outers and CW holes, even when the
  // fitted paths arrived with that winding swapped.
  let normalizedPaths = basePaths
  try {
    const unioned = booleanUnion(basePaths, null)
    if (unioned?.length) normalizedPaths = unioned
  } catch (err) {
    console.warn('[cutterGeometry] sable winding normalize failed:', err)
  }

  const outers = []
  const rawHoles = []
  for (const rawLoop of normalizedPaths) {
    const loop = densify(rawLoop, 0.5)
    if (!loop || loop.length < 3) continue
    const area = loopSignedArea(loop)
    if (area > 1e-6) outers.push(loop)
    else if (area < -1e-6) rawHoles.push(loop)
  }

  let finalOuters = outers
  let finalHoles = rawHoles
  let stampOuter = null
  let centerHole = null

  // Line drawing: one outer cutter, and the largest hole is plain dough
  // instead of a window. Smaller holes stay window cutters.
  if (settings.sableLineDrawingMode && !settings.sableStampMode) {
    if (outers.length > 0) {
      let maxArea = -1
      let maxOuter = null
      for (const loop of outers) {
        const area = Math.abs(loopSignedArea(loop))
        if (area > maxArea) {
          maxArea = area
          maxOuter = loop
        }
      }
      finalOuters = [maxOuter]
    }
    if (rawHoles.length > 0) {
      let maxArea = -1
      let maxHoleIdx = -1
      for (let i = 0; i < rawHoles.length; i++) {
        const area = Math.abs(loopSignedArea(rawHoles[i]))
        if (area > maxArea) {
          maxArea = area
          maxHoleIdx = i
        }
      }
      finalHoles = rawHoles.filter((_, idx) => idx !== maxHoleIdx)
    }
  }

  // Stamp: the largest outer is the cutter, and the hole nearest the design
  // center is the only window. Bridges are built separately.
  if (settings.sableStampMode) {
    if (outers.length > 0) {
      let maxArea = -1
      for (const loop of outers) {
        const area = Math.abs(loopSignedArea(loop))
        if (area > maxArea) {
          maxArea = area
          stampOuter = loop
        }
      }
    }
    const bounds = computePathsBounds(normalizedPaths)
    let minCenterDist = Infinity
    for (const hole of rawHoles) {
      const hb = computePathBounds(hole)
      const dist = Math.hypot(hb.cx - bounds.cx, hb.cy - bounds.cy)
      if (dist < minCenterDist) {
        minCenterDist = dist
        centerHole = hole
      }
    }
  }

  const geometries = []

  function flipGeoZ(geo, zMax) {
    if (!geo?.attributes?.position) return null
    const pos = geo.attributes.position.array
    for (let i = 0; i < pos.length; i += 3) pos[i + 2] = zMax - pos[i + 2]
    geo.attributes.position.needsUpdate = true
    const idx = geo.index?.array
    if (idx) {
      for (let i = 0; i < idx.length; i += 3) {
        const tmp = idx[i + 1]
        idx[i + 1] = idx[i + 2]
        idx[i + 2] = tmp
      }
      geo.index.needsUpdate = true
    }
    geo.computeVertexNormals()
    return geo
  }

  function buildHalf(loop, zB, zS, zT) {
    const thickLoop = pickOuterPath(offsetPathsManifold([loop], thickness, OFFSET_OPTS))
    const tipLoop = pickOuterPath(offsetPathsManifold([loop], tipWidth, OFFSET_OPTS))
    if (!thickLoop || !tipLoop) return null
    return buildStraightBladeShell({
      bottomLoop: densify(thickLoop, 0.2),
      topLoop: densify(tipLoop, 0.2),
      cavityLoop: densify(loop, 0.2),
      zBase: zB,
      zSeam: zS,
      zTip: zT,
      radialGap: thickness - tipWidth,
    })
  }

  function commitShell(shell) {
    if (!shell?.attributes?.position?.count) {
      shell?.dispose?.()
      return null
    }
    const solid = shellToBladeGeometry(shell)
    if (solid?.attributes?.position?.count) {
      if (solid !== shell) shell.dispose()
      return solid
    }
    solid?.dispose?.()
    return shell
  }

  const outersToBuild = settings.sableStampMode ? (stampOuter ? [stampOuter] : []) : finalOuters
  for (const loop of outersToBuild) {
    const topSolid = commitShell(buildHalf(loop, midZ - 0.05, depth - chamfer, depth))
    if (topSolid) geometries.push(topSolid)

    const bottom = buildHalf(loop, 0, midZ - chamfer, midZ)
    if (bottom) {
      const flipped = flipGeoZ(bottom, midZ)
      const bottomSolid = commitShell(flipped)
      if (bottomSolid) geometries.push(bottomSolid)
    }
  }

  // One scale for the whole window group, about the group center, so the
  // longest side of that group is `sableInnerHole` mm and the bridges meet
  // the windows that were actually built.
  const holesToBuild = settings.sableStampMode ? (centerHole ? [centerHole] : []) : finalHoles
  const targetSize = Math.max(Number(settings.sableInnerHole) || 30, 2)
  let hcx = 0
  let hcy = 0
  let scale = 1
  if (holesToBuild.length > 0) {
    const hBounds = computePathsBounds(holesToBuild)
    const currentSize = Math.max(hBounds.width, hBounds.height)
    scale = currentSize > 0.001 ? targetSize / currentSize : 1
    hcx = hBounds.cx
    hcy = hBounds.cy
  }
  const scaledHoles = holesToBuild.map((hole) =>
    hole.map((p) => ({
      x: hcx + (p.x - hcx) * scale,
      y: hcy + (p.y - hcy) * scale,
    })),
  )

  for (const hole of scaledHoles) {
    // A CW hole, reversed, is a CCW solid. An outward offset then grows
    // the wall into the dough. The cutting face stays on the scaled window.
    // One sharp lip at the top, flat where it meets the bridge or stamp.
    const solidLoop = hole.slice().reverse()
    const innerSolid = commitShell(buildHalf(solidLoop, midZ, depth - chamfer, depth))
    if (innerSolid) geometries.push(innerSolid)
  }

  if (settings.sableStampMode) {
    const sHeight = Math.max(Number(settings.sableStampHeight) || 3.0, 0.5)
    const pThick = Number(settings.sablePatternThickness) || 0
    let stampPaths = basePaths

    // Thickness belongs to the artwork only. The loops above already
    // locked the walls to the unoffset trace.
    if (Math.abs(pThick) > 0.001) {
      try {
        const thickened = offsetPathsManifold(basePaths, pThick, OFFSET_OPTS)
        if (thickened?.length) stampPaths = thickened
      } catch (err) {
        console.warn('[cutterGeometry] sable pattern offset failed:', err)
      }
    }

    if (stampOuter) {
      try {
        // Clip to the dough. Nothing outside the outer face, nothing in the window.
        let clipped = booleanIntersection([stampOuter], stampPaths)
        if (scaledHoles.length > 0 && clipped?.length) {
          const punched = booleanDifference(clipped, scaledHoles)
          if (punched?.length) clipped = punched
        }
        if (clipped?.length) stampPaths = clipped
      } catch (err) {
        console.warn('[cutterGeometry] sable stamp clip failed:', err)
      }
    }

    if (stampPaths.length > 0) {
      const stampGeo = extrudePaths(stampPaths, sHeight, { z0: midZ })
      if (stampGeo) geometries.push(stampGeo)
    }
  }

  // Bridges are independent of the stamp. A thinned pattern can break into
  // islands; the bars tie those islands to the walls.
  if (settings.sableBridgesEnabled ?? true) {
    const scaledDoughPaths = [...outersToBuild, ...scaledHoles]
    const bounds = computePathsBounds(scaledDoughPaths)
    const span = Math.hypot(bounds.width, bounds.height) * 1.5
    // The center can go down to 0.1 mm. A missing width still defaults to 4.
    const bw = Math.max(Number(settings.sableBridgeWidth) || 4, 0.1)
    const bType = settings.sableBridgeType || 'cross'
    // Full width at the far tips of a flared bar. An explicit 0 is kept,
    // then raised so the ends are never narrower than the center.
    const flareInput = Number(settings.sableBridgeFlare)
    const flareTotal = Math.max(Number.isFinite(flareInput) ? flareInput : 15, bw)
    const cx = bounds.cx
    const cy = bounds.cy
  
    const sableBarRect = (barCx, barCy, barSpan, width, vertical) => {
      const hw = barSpan / 2
      const hh = width / 2
      if (vertical) {
        return [
          { x: barCx - hh, y: barCy - hw },
          { x: barCx + hh, y: barCy - hw },
          { x: barCx + hh, y: barCy + hw },
          { x: barCx - hh, y: barCy + hw },
        ]
      }
      return [
        { x: barCx - hw, y: barCy - hh },
        { x: barCx + hw, y: barCy - hh },
        { x: barCx + hw, y: barCy + hh },
        { x: barCx - hw, y: barCy + hh },
      ]
    }
  
    const barRects = []
    if (bType === 'horizontal') {
      barRects.push(sableBarRect(cx, cy, span, bw, false))
    } else if (bType === 'flared') {
      const flare = flareTotal / 2
      const halfW = bw / 2
      barRects.push([
        { x: cx - span, y: cy - flare },
        { x: cx, y: cy - halfW },
        { x: cx + span, y: cy - flare },
        { x: cx + span, y: cy + flare },
        { x: cx, y: cy + halfW },
        { x: cx - span, y: cy + flare },
      ])
    } else if (bType === 'cross_flared') {
      const flare = flareTotal / 2
      const halfW = bw / 2
      barRects.push([
        { x: cx - span, y: cy - flare },
        { x: cx, y: cy - halfW },
        { x: cx + span, y: cy - flare },
        { x: cx + span, y: cy + flare },
        { x: cx, y: cy + halfW },
        { x: cx - span, y: cy + flare },
      ])
      barRects.push([
        { x: cx - flare, y: cy - span },
        { x: cx + flare, y: cy - span },
        { x: cx + halfW, y: cy },
        { x: cx + flare, y: cy + span },
        { x: cx - flare, y: cy + span },
        { x: cx - halfW, y: cy },
      ])
    } else {
      barRects.push(sableBarRect(cx, cy, span, bw, false))
      barRects.push(sableBarRect(cx, cy, span, bw, true))
    }
  
    const seat = offsetPathsManifold(scaledDoughPaths, SABLE_BRIDGE_SEAT_MM, OFFSET_OPTS)
    const seatPaths = seat?.length ? seat : scaledDoughPaths
    const clippedBridges = booleanIntersection(seatPaths, barRects)
    if (clippedBridges?.length) {
      const bridgesGeo = extrudePaths(clippedBridges, bDepth, { z0: midZ })
      if (bridgesGeo) geometries.push(bridgesGeo)
    }
  }

  if (geometries.length === 0) return null
  let finalGeo = geometries[0]
  for (let i = 1; i < geometries.length; i++) {
    const unioned = unionGeometry(finalGeo, geometries[i])
    if (unioned !== finalGeo) finalGeo.dispose()
    if (unioned !== geometries[i]) geometries[i].dispose()
    finalGeo = unioned
  }
  return finalGeo
}

/**
 * Fits the raw traced/vectorized silhouette so it IS the inner cutting
 * cavity at `settings.width` × `settings.height`. Blade thickness and
 * handle width are applied afterwards as absolute millimetre outward
 * round-join offsets.
 *
 * The last step re-measures the oriented box. Chord decimation and the
 * fit multiply can leave an extremum more than 0.02 mm off the request;
 * `enforcePathDimensions` scales that out about the box center. Nothing
 * is logged.
 */
export function fitInnerCavityPaths(rawPaths, settings) {
  if (!rawPaths || rawPaths.length === 0) return []
  const fitted = fitPathsToSize(rawPaths, settings.width, settings.height, settings.aspectLocked)
  // Default ON. An explicit `false` is the only way to keep the source
  // orientation. Missing keys on older profiles still mirror.
  const oriented = settings.mirrorDesign === false ? fitted : mirrorPathsAcrossX(fitted)
  return enforcePathDimensions(oriented, settings.width, settings.height, settings.aspectLocked)
}

/**
 * Isolation (clipper integer snap, a resolved crossing) can move a cavity
 * that was already on the requested size. Re-measure `after` and scale it
 * back only in that case.
 *
 * A silhouette that no longer matches — an erased corner, a stroke past
 * the edge, a dropped bounding frame — keeps the millimetre scale pinned
 * by the original fit (Rule 6). `enforcePathDimensions` returns the same
 * array when no scale is required, which is how that case is detected.
 */
function relockCavityDimensions(before, after, settings) {
  if (!after?.length || !before?.length) return after
  const beforeLocked = enforcePathDimensions(before, settings.width, settings.height, settings.aspectLocked)
  if (beforeLocked !== before) return after
  return enforcePathDimensions(after, settings.width, settings.height, settings.aspectLocked)
}

// 90° plate edges crease. The pillar's 64-gon is about 5.6° and stays smooth.
const LIGHTBOX_CREASE_DEG = 40

/**
 * Shadow lightbox base frame. `buildLightboxParts` returns `[base, pillar]`.
 * Tall walls are not generated in this pass. `exportParts` drops a part
 * before it is meshed.
 */
export function buildLightboxGeometry(settings, stencilPaths) {
  const parts = buildLightboxParts(settings, stencilPaths)
  if (!parts) return null
  const base = Array.isArray(parts) ? parts[0] : parts.base
  const pillar = Array.isArray(parts) ? parts[1] : parts.pillar
  const model = {}
  if (base) model.base = finalizeGeometry(base, LIGHTBOX_CREASE_DEG)
  if (pillar) model.pillar = finalizeGeometry(pillar, LIGHTBOX_CREASE_DEG)
  return Object.keys(model).length > 0 ? model : null
}

/**
 * Generates all model geometries according to settings and 2D contour
 * paths. Requires manifold-3d to already be initialized (the geometry
 * worker awaits `initManifold()` before calling this).
 */
export function generateFullCutterModel(basePaths, settings, fontsByKey = null) {
  if (settings?.thingToMake === 'lightbox') {
    return buildLightboxGeometry(settings, basePaths)
  }
  if (!basePaths || basePaths.length === 0) return null

  if (settings.thingToMake === 'stencil') {
    return { stencil: buildStencilModel(basePaths, settings).geometry }
  }

  // Keep every window. Isolating the outer contour would drop the hole
  // cutters this product exists to build.
  if (settings.thingToMake === 'sable') {
    let geo = buildSableGeometry(basePaths, settings)
    if (geo) {
      // Wall text measures the regular blade. Feed it the Sablé wall so
      // the glyphs sit on this cutter: full thickness, no press handle,
      // chamfer read from the Sablé slope.
      const textSettings = {
        ...settings,
        bladeDepth: settings.sableDepth,
        bladeThickness: settings.sableThickness,
        cutterChamferHeight: settings.sableChamfer,
        sharpCutter: true,
        handleHeight: 0,
      }
      const wallTextGeo = buildCutterWallTextGeometry(basePaths, textSettings, fontsByKey)
      if (wallTextGeo) {
        const fused = unionGeometry(geo, wallTextGeo)
        if (fused !== geo) geo.dispose()
        if (fused !== wallTextGeo) wallTextGeo.dispose()
        geo = fused
      }
    }
    return {
      blade: finalizeGeometry(geo, 80),
      handle: null,
      bars: null,
      stamp: null,
      wallText: null,
    }
  }

  const isSolidOnly = settings.thingToMake === 'stamp' || settings.thingToMake === 'practice'
  const needsCutterWalls = !isSolidOnly

  // Drop the bounding frame before isolation. `buildStampGeometry` applies
  // the same parity flip to its own copy of `basePaths`, so this local
  // copy is only for the cutter cavity.
  let cutterSource = basePaths
  if (settings.deleteOuterEdge) {
    cutterSource = dropBoundingFrame(basePaths)
    if (!cutterSource || cutterSource.length === 0) return null
  }

  let cutterCavityPaths = cutterSource
  if (needsCutterWalls) {
    // Isolate outer silhouette so inner details don't become solid internal blocks.
    // Do NOT RDP-simplify after isolation or after the Manifold clearance
    // offset — that pass was the source of uneven, faceted outer walls.
    cutterCavityPaths = isolateOuterContour(cutterSource)
    if (!cutterCavityPaths || cutterCavityPaths.length === 0) return null
    // Last 2D measure before any absolute-mm clearance offset or extrusion.
    // A cavity that still matches the request is scaled back onto it when
    // isolation moved the box by more than 0.02 mm.
    cutterCavityPaths = relockCavityDimensions(cutterSource, cutterCavityPaths, settings)
    // Cutter + Stamp: a positive `stampImprintThickness` grows the stamp
    // plate by that same Round offset, and `stampBaseOffset` grows the
    // plate again. Expand the cavity by both plus `stampClearance` in one
    // Minkowski sum so the grown stamp still sits loosely inside the blade.
    // A negative thickness does not move the plate, so it does not add to
    // the cavity.
    if (settings.thingToMake === 'cutterStamp') {
      const clearance = Math.max(settings.stampClearance ?? 0, 0)
      // Dedicated stamp art does not grow the plate when the imprint
      // thickens, so the blade must not open up for that delta either.
      const imprintGrowth = dedicatedStampArtwork(settings)
        ? 0
        : Math.max(settings.stampImprintThickness || 0, 0)
      const baseOffset = Math.max(Number(settings.stampBaseOffset) || 0, 0)
      const expansion = clearance + imprintGrowth + baseOffset
      if (expansion > 0.0001) {
        const cleared = offsetCavity(cutterCavityPaths, expansion)
        if (cleared.length > 0) cutterCavityPaths = cleared
      }
    }
  }

  let bladeGeo = needsCutterWalls ? buildBladeGeometry(cutterCavityPaths, settings) : null
  if (bladeGeo) bladeGeo.translate(0, 0, computeBladeBaseZ(settings))
  const handleGeo = needsCutterWalls ? buildHandleGeometry(cutterCavityPaths, settings) : null
  const barsGeo = needsCutterWalls ? buildCenterBarsGeometry(cutterCavityPaths, settings) : null
  const stampGeo = buildStampGeometry(basePaths, settings)
  const wallTextGeo = needsCutterWalls
    ? buildCutterWallTextGeometry(cutterCavityPaths, settings, fontsByKey)
    : null

  if (bladeGeo && wallTextGeo) {
    bladeGeo = unionGeometry(bladeGeo, wallTextGeo)
  }

  // Closed blade + closed handle share the junction plane. Sink the blade
  // 0.01mm into the handle so the boolean has a positive-volume overlap
  // and deletes both caps instead of leaving a coplanar sheet.
  const fusedHandle = Boolean(handleGeo)
  if (handleGeo) {
    if (bladeGeo) bladeGeo.translate(0, 0, -CHAMFER_STACK_OVERLAP_MM)
    const fused = unionGeometry(bladeGeo, handleGeo)
    if (bladeGeo && fused !== bladeGeo) bladeGeo.dispose()
    if (fused !== handleGeo) handleGeo.dispose()
    bladeGeo = fused
  }
  if (barsGeo) {
    const fused = unionGeometry(bladeGeo, barsGeo)
    if (bladeGeo && fused !== bladeGeo) bladeGeo.dispose()
    if (fused !== barsGeo) barsGeo.dispose()
    bladeGeo = fused
  }

  return {
    blade: finalizeGeometry(bladeGeo, fusedHandle ? 80 : 7),
    handle: null,
    bars: null,
    stamp: finalizeGeometry(stampGeo, 40, STAMP_WELD_TOLERANCE_MM),
    wallText: null,
  }
}
