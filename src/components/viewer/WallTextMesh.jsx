import { useModel } from '../../context/useModel.js'

const TEXT_COLOR = '#f4f0ea'

/**
 * Renders `model.wallText` as a real, volumetric mesh, IF it's ever
 * present. In the current pipeline it never is: `generateFullCutterModel`
 * (see cutterGeometry.js) physically fuses every configured wall text into
 * `model.blade` itself via a real CSG boolean union, so the text renders
 * (and exports) as part of the blade's own surface — a single continuous
 * solid, not two coincident meshes that z-fight. This component is kept as
 * a harmless no-op safety net for that key, not part of the normal render
 * path.
 */
export function WallTextMesh() {
  const { model } = useModel()
  if (!model?.wallText) return null

  return (
    <mesh geometry={model.wallText}>
      <meshStandardMaterial color={TEXT_COLOR} roughness={1} metalness={0} />
    </mesh>
  )
}
