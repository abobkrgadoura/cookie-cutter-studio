import { memo } from 'react'
import { useModel } from '../../context/useModel.js'
import { useSettings } from '../../context/useSettings.js'
import { LIGHTBOX_MESH_KEYS } from '../../lib/presets.js'
import { computeStampZ } from '../../lib/pathMetrics.js'

// Roughness is 1, so hue is the only separator. Cutter body stays red;
// the stamp plate is teal so the imprint reads inside the walls.
const CUTTER_RED = '#d64545'
const HANDLE_RED = '#d64545'
const STAMP_CORAL = '#2f9d8f'
const STENCIL_PLASTIC = '#FC5A5A'
const STENCIL_ROUGHNESS = 0.3
const STENCIL_METALNESS = 0.1
const LIGHTBOX_PAPER = '#f4ead8'

// Cookiecad's "Studio Matte" finish: fully non-reflective so the coarse
// 8-slice taper stairs are hidden by interpolated vertex normals instead
// of being lit as specular stripes (Moire). Roughness 1 kills highlights;
// metalness 0 keeps the surface dielectric. `flatShading: false` is
// required so MeshStandardMaterial interpolates computeVertexNormals().
const STUDIO_MATTE_ROUGHNESS = 1
const STUDIO_MATTE_METALNESS = 0

export const CutterMesh = memo(function CutterMesh() {
  const { model } = useModel()
  const { settings } = useSettings()

  if (!model) return null

  // The stamp always sits flush on the build plate (z=0) so it prints
  // without supports. Shared with stlExport.js so the exported file always
  // matches the on-screen model.
  const stampZ = computeStampZ(settings)

  return (
    <group>
      {model.stencil && settings.thingToMake === 'stencil' && (
        <mesh geometry={model.stencil}>
          <meshStandardMaterial
            color={STENCIL_PLASTIC}
            roughness={STENCIL_ROUGHNESS}
            metalness={STENCIL_METALNESS}
            flatShading={false}
            dithering
          />
        </mesh>
      )}

      {settings.thingToMake === 'lightbox' &&
        LIGHTBOX_MESH_KEYS.filter((key) => model[key]).map((key) => (
          <mesh key={key} geometry={model[key]}>
            <meshStandardMaterial
              color={LIGHTBOX_PAPER}
              roughness={STUDIO_MATTE_ROUGHNESS}
              metalness={STUDIO_MATTE_METALNESS}
              flatShading={false}
              dithering
            />
          </mesh>
        ))}

      {model.blade && (
        <mesh geometry={model.blade}>
          <meshStandardMaterial
            color={CUTTER_RED}
            roughness={STUDIO_MATTE_ROUGHNESS}
            metalness={STUDIO_MATTE_METALNESS}
            flatShading={false}
            dithering
          />
        </mesh>
      )}

      {model.handle && (
        <mesh geometry={model.handle}>
          <meshStandardMaterial
            color={HANDLE_RED}
            roughness={STUDIO_MATTE_ROUGHNESS}
            metalness={STUDIO_MATTE_METALNESS}
            flatShading={false}
            dithering
          />
        </mesh>
      )}

      {model.bars && (
        <mesh geometry={model.bars}>
          <meshStandardMaterial
            color={CUTTER_RED}
            roughness={STUDIO_MATTE_ROUGHNESS}
            metalness={STUDIO_MATTE_METALNESS}
            flatShading={false}
            dithering
          />
        </mesh>
      )}

      {model.stamp && (
        <mesh geometry={model.stamp} position={[0, 0, stampZ]}>
          <meshStandardMaterial
            color={STAMP_CORAL}
            roughness={STUDIO_MATTE_ROUGHNESS}
            metalness={STUDIO_MATTE_METALNESS}
            flatShading={false}
            dithering
          />
        </mesh>
      )}
    </group>
  )
})
