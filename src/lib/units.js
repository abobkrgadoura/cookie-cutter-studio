export const MM_PER_INCH = 25.4

export function toDisplay(mm, unit) {
  if (unit === 'inch') return Number((mm / MM_PER_INCH).toFixed(3))
  return Number(Number(mm).toFixed(2))
}

export function fromDisplay(value, unit) {
  const n = Number(value)
  if (Number.isNaN(n)) return 0
  return unit === 'inch' ? n * MM_PER_INCH : n
}

export function unitLabel(unit) {
  return unit === 'inch' ? 'in' : 'mm'
}

export function formatDim(mm, unit) {
  const v = toDisplay(mm, unit)
  return `${v.toFixed(unit === 'inch' ? 3 : 2)} ${unitLabel(unit)}`
}

export function formatArea(widthMm, heightMm, unit) {
  const areaMm2 = widthMm * heightMm
  if (unit === 'inch') {
    const areaIn2 = areaMm2 / (MM_PER_INCH * MM_PER_INCH)
    return `${areaIn2.toLocaleString(undefined, { maximumFractionDigits: 2 })} in²`
  }
  return `${Math.round(areaMm2).toLocaleString()} mm²`
}
