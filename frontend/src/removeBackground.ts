/**
 * Removes the solid/checkered grey-white background from a sprite image
 * using a flood-fill from the corners with colour tolerance.
 * Returns a new HTMLCanvasElement with the background set to transparent.
 */
export function removeBackground(
  img: HTMLImageElement,
  tolerance = 40
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight

  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data
  const w = canvas.width
  const h = canvas.height

  // Sample background colour from top-left corner
  const bgR = data[0]
  const bgG = data[1]
  const bgB = data[2]

  const visited = new Uint8Array(w * h)

  function colorMatch(idx: number): boolean {
    return (
      Math.abs(data[idx] - bgR) <= tolerance &&
      Math.abs(data[idx + 1] - bgG) <= tolerance &&
      Math.abs(data[idx + 2] - bgB) <= tolerance
    )
  }

  // BFS flood fill from all four corners
  const queue: number[] = []
  const seeds = [
    0,
    w - 1,
    (h - 1) * w,
    (h - 1) * w + (w - 1),
  ]
  for (const s of seeds) {
    if (!visited[s]) {
      visited[s] = 1
      queue.push(s)
    }
  }

  while (queue.length > 0) {
    const pos = queue.pop()!
    const idx = pos * 4
    // Make transparent
    data[idx + 3] = 0

    const x = pos % w
    const y = Math.floor(pos / w)
    const neighbors = [
      x > 0 ? pos - 1 : -1,
      x < w - 1 ? pos + 1 : -1,
      y > 0 ? pos - w : -1,
      y < h - 1 ? pos + w : -1,
    ]
    for (const n of neighbors) {
      if (n >= 0 && !visited[n] && colorMatch(n * 4)) {
        visited[n] = 1
        queue.push(n)
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

/**
 * Loads an image URL and returns a canvas with background removed.
 */
export function loadSpriteSheet(url: string, tolerance = 40): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(removeBackground(img, tolerance))
    img.onerror = reject
    img.src = url
  })
}
