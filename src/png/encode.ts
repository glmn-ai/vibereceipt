// A small PNG encoder: 8-bit RGB, adaptive per-row filtering, zlib from Node.
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8)
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length)
  return out
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Encodes an RGB image (`rgb.length === width * height * 3`) as PNG. Each row
 * gets the filter with the smallest sum of absolute differences (the usual
 * libpng heuristic).
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`bad PNG size ${width}x${height}`)
  }
  if (rgb.length !== width * height * 3) throw new Error('pixel buffer does not match the size')
  const stride = width * 3
  const raw = new Uint8Array((stride + 1) * height)
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride))
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const prev = y > 0 ? row - stride : -1
    let best = 0
    let bestScore = Infinity
    for (let filter = 0; filter < 5; filter++) {
      const out = candidates[filter]
      let score = 0
      for (let i = 0; i < stride; i++) {
        const x = rgb[row + i]
        const a = i >= 3 ? rgb[row + i - 3] : 0
        const b = prev >= 0 ? rgb[prev + i] : 0
        const c = prev >= 0 && i >= 3 ? rgb[prev + i - 3] : 0
        let v: number
        switch (filter) {
          case 0:
            v = x
            break
          case 1:
            v = x - a
            break
          case 2:
            v = x - b
            break
          case 3:
            v = x - ((a + b) >> 1)
            break
          default:
            v = x - paeth(a, b, c)
        }
        v &= 0xff
        out[i] = v
        score += v < 128 ? v : 256 - v
        if (score >= bestScore) break
      }
      if (score < bestScore) {
        bestScore = score
        best = filter
      }
    }
    // Recompute the winner fully (scoring may have stopped early for others, never for it).
    raw[y * (stride + 1)] = best
    raw.set(candidates[best], y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0))
  ])
}
