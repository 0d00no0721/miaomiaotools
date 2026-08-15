/**
 * Image compression helper: reads a File, downscales to max 1920px wide via
 * Canvas, and re-encodes as JPEG quality 0.7 to keep settings.yaml manageable.
 * Returns a base64 data URL.
 * @param file - the image file to compress.
 * @returns promise resolving to the compressed data URL.
 */
export async function compressImage(file: File, maxWidth = 1920, quality = 0.7): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file)
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxWidth / img.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return dataUrl
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

/** Read a File as a data URL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(reader.result as string) }
    reader.onerror = () => { reject(new Error('File read failed')) }
    reader.readAsDataURL(file)
  })
}

/** Load an image from a data URL. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { resolve(img) }
    img.onerror = () => { reject(new Error('Image load failed')) }
    img.src = src
  })
}
