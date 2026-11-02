import { Line, Text } from '@react-three/drei'
import { formatArea, formatDim } from '../../lib/units.js'
import { useTheme } from '../../context/useTheme.js'

export function DimensionLines({ width, height, unit, z = 0 }) {
  const { isDark } = useTheme()
  const pad = Math.max(width, height) * 0.08 + 4
  const left = -width / 2
  const right = width / 2
  const bottom = -height / 2
  const top = height / 2
  const xLine = left - pad
  const yLine = bottom - pad
  
  // تغيير اللون أوتوماتيكياً حسب وضع الموقع
  const color = isDark ? '#f2f2f6' : '#000000'
  const subColor = isDark ? '#c8c8d4' : '#555555'
  
  const tick = 2.2

  return (
    <group position={[0, 0, z]}>
      <Line
        points={[
          [xLine, bottom, 0],
          [xLine, top, 0],
        ]}
        color={color}
        lineWidth={1}
      />
      <Line points={[[xLine - tick, bottom, 0], [xLine + tick, bottom, 0]]} color={color} lineWidth={1} />
      <Line points={[[xLine - tick, top, 0], [xLine + tick, top, 0]]} color={color} lineWidth={1} />
      <Text
        position={[xLine - 3.2, 0, 0]}
        rotation={[0, 0, Math.PI / 2]}
        fontSize={3.2}
        color={color}
        anchorX="center"
        anchorY="middle"
      >
        {formatDim(height, unit)}
      </Text>

      <Line
        points={[
          [left, yLine, 0],
          [right, yLine, 0],
        ]}
        color={color}
        lineWidth={1}
      />
      <Line points={[[left, yLine - tick, 0], [left, yLine + tick, 0]]} color={color} lineWidth={1} />
      <Line points={[[right, yLine - tick, 0], [right, yLine + tick, 0]]} color={color} lineWidth={1} />
      <Text position={[0, yLine - 4.4, 0]} fontSize={3.2} color={color} anchorX="center" anchorY="middle">
        {formatDim(width, unit)}
      </Text>
      <Text position={[0, yLine - 8.6, 0]} fontSize={2.4} color={subColor} anchorX="center" anchorY="middle">
        Area {formatArea(width, height, unit)}
      </Text>
    </group>
  )
}