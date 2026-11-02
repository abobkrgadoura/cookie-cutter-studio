import { memo, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows, OrbitControls } from '@react-three/drei'
import { useSettings } from '../../context/useSettings.js'
import { useTheme } from '../../context/useTheme.js'
import { CutterMesh } from './CutterMesh.jsx'
import { DimensionLines } from './DimensionLines.jsx'
import { WallTextMesh } from './WallTextMesh.jsx'

const GL_OPTIONS = { antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true }
const SHADOW_ROTATION = [Math.PI, 0, 0]
const SHADOW_POSITION = [0, 0, 0]

function sheetSize(settings) {
  if (settings.thingToMake === 'stencil') {
    return {
      width: settings.stencilBoardWidth || settings.width,
      height: settings.stencilBoardHeight || settings.height,
      targetZ: 0.25,
    }
  }
  if (settings.thingToMake === 'lightbox') {
    // Base-frame rim only. Tall walls are separate parts and are not in
    // this pass, so the camera frames the 12 mm tray instead of boxDepth.
    const rim = 12
    return {
      width: settings.boxWidth || 120,
      height: settings.boxHeight || 150,
      targetZ: rim / 2,
    }
  }
  return {
    width: settings.width,
    height: settings.height,
    targetZ:
      (settings.thingToMake === 'sable' ? settings.sableDepth : settings.handleHeight + settings.bladeDepth) / 2,
  }
}

/**
 * Lights, helpers and controls. Takes only the numbers it draws with, so a
 * settings change that does not move the sheet skips this subtree. The
 * meshes subscribe to the model themselves.
 */
const Scene = memo(function Scene({ width, height, targetZ, unit, showDimensions }) {
  const maxDim = Math.max(width, height, 40)
  const target = useMemo(() => [0, 0, targetZ], [targetZ])

  return (
    <>
      {/* إضاءة ساطعة مخصصة لبرامج الـ CAD لتوضيح التفاصيل */}
      <ambientLight intensity={1.2} />
      <directionalLight position={[20, 50, 80]} intensity={0.6} />
      <directionalLight position={[-50, -50, 50]} intensity={0.4} />
      
      <CutterMesh />
      <WallTextMesh />
      
      {/* هذا السطر هو الذي يربط خطوط الأبعاد بالزر الجديد */}
      {showDimensions && (
        <DimensionLines
          width={width}
          height={height}
          unit={unit}
          z={0.2}
        />
      )}
      
      <ContactShadows
        position={SHADOW_POSITION}
        rotation={SHADOW_ROTATION}
        opacity={0.3}
        scale={maxDim * 3}
        blur={2.0}
      />
      <OrbitControls
        enableDamping
        makeDefault
        minDistance={maxDim * 0.6}
        maxDistance={maxDim * 6}
        target={target}
      />
    </>
  )
})

export const Viewer3D = memo(function Viewer3D() {
  const { settings } = useSettings()
  const { isDark } = useTheme()
  const sheet = sheetSize(settings)
  const maxDim = Math.max(sheet.width, sheet.height, 40)
  const lightbox = settings.thingToMake === 'lightbox'
  const camera = useMemo(() => {
    let position = [0, -maxDim * 1.15, maxDim * 1.35]
    if (lightbox) {
      const width = settings.boxWidth || 120
      const height = settings.boxHeight || 150
      const span = Math.max(width, height)
      // Front-left, slightly above the tray, matching the base-frame photos.
      position = [width * 0.55, -(height * 0.72), span * 0.62]
    }
    return {
      position,
      up: [0, 0, 1],
      fov: 42,
      near: Math.max(maxDim * 0.01, 0.05),
      far: maxDim * 30,
    }
  }, [
    lightbox,
    maxDim,
    settings.boxWidth,
    settings.boxHeight,
  ])

  return (
    <div className="relative h-full min-h-0 flex-1" style={{ background: 'var(--canvas-vignette)' }}>
      <Canvas key={settings.thingToMake} shadows camera={camera} gl={GL_OPTIONS}>
        <color attach="background" args={[isDark ? '#1c1c28' : '#ececf3']} />
        <Scene
          width={sheet.width}
          height={sheet.height}
          targetZ={sheet.targetZ}
          unit={settings.unit}
          showDimensions={settings.showDimensions !== false}
        />
      </Canvas>
    </div>
  )
})
