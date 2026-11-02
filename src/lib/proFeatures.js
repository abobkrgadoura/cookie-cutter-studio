/** True when the current design uses a paid product type or wall text. */
export function designUsesProFeatures(settings) {
  const isUsingProProduct = settings?.thingToMake && settings.thingToMake !== 'cutter'
  const isUsingProText =
    Boolean(settings?.wallTextEnabled) &&
    Array.isArray(settings.wallTexts) &&
    settings.wallTexts.some((item) => String(item?.text ?? '').trim().length > 0)
  return Boolean(isUsingProProduct || isUsingProText)
}
