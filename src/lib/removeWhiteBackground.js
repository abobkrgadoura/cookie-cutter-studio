const WHITE_LEVEL = 240

/**
 * Preview-only chroma key. Near-white pixels become transparent so the
 * editor grid shows through. The file used for tracing is left unchanged.
 */
export function removeWhiteBackground(url) {
  return new Promise((resolve, reject) => {
    if (typeof url !== 'string' || !url) {
      reject(new Error('Missing image'))
      return
    }

    const img = new Image()
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous'

    img.onload = () => {
      try {
        const width = img.naturalWidth || img.width
        const height = img.naturalHeight || img.height
        if (!(width > 0) || !(height > 0)) {
          reject(new Error('Image has no pixels'))
          return
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) {
          reject(new Error('Canvas unavailable'))
          return
        }

        ctx.drawImage(img, 0, 0, width, height)
        const imageData = ctx.getImageData(0, 0, width, height)
        const pixels = imageData.data
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i]
          const g = pixels[i + 1]
          const b = pixels[i + 2]
          if (r > WHITE_LEVEL && g > WHITE_LEVEL && b > WHITE_LEVEL) pixels[i + 3] = 0
        }
        ctx.putImageData(imageData, 0, 0)
        resolve(canvas.toDataURL('image/png'))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Failed to remove background'))
      }
    }

    img.onerror = () => reject(new Error('Failed to read image'))
    img.src = url
  })
}
