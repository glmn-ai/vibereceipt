import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { crc32, encodePng } from '../src/png/encode.js'
import { renderReceiptPng } from '../src/png/render.js'
import { buildReceipt } from '../src/receipt/model.js'
import { buildStats } from '../src/stats.js'
import { allTime } from '../src/period.js'
import { demoScan, DEMO_NOW } from '../src/demo.js'

interface Chunk {
  type: string
  data: Buffer
}

function chunks(png: Buffer): Chunk[] {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const out: Chunk[] = []
  let at = 8
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(png, at + 4, at + 8 + length), `CRC of ${type}`)
    out.push({ type, data })
    at += 12 + length
  }
  return out
}

/** A reference decoder for 8-bit RGB with all five filter types. */
function decode(png: Buffer): { width: number; height: number; rgb: Uint8Array } {
  const list = chunks(png)
  const ihdr = list[0].data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  assert.equal(ihdr[8], 8)
  assert.equal(ihdr[9], 2)
  const raw = inflateSync(Buffer.concat(list.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = width * 3
  const rgb = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i]
      const a = i >= 3 ? rgb[y * stride + i - 3] : 0
      const b = y > 0 ? rgb[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= 3 ? rgb[(y - 1) * stride + i - 3] : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      rgb[y * stride + i] = (v + pred) & 0xff
    }
  }
  return { width, height, rgb }
}

test('crc32 matches the standard check values', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082)
})

test('the encoder round-trips pixels exactly', () => {
  const width = 37
  const height = 23
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7919 + (i >> 5) * 13) & 0xff
  // A few flat rows so several filter types get chosen.
  rgb.fill(200, 0, width * 3 * 4)
  const png = encodePng(width, height, rgb)
  assert.deepEqual(
    chunks(png).map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND']
  )
  const decoded = decode(png)
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assert.deepEqual(decoded.rgb, rgb)
  assert.throws(() => encodePng(2, 2, new Uint8Array(5)))
})

test('the receipt renders as a 1080-wide PNG, at least 4:5', () => {
  const stats = buildStats(demoScan(), { period: allTime(DEMO_NOW), now: DEMO_NOW, demo: true })
  const png = renderReceiptPng(buildReceipt(stats))
  const { width, height, rgb } = decode(png)
  assert.equal(width, 1080)
  assert.ok(height >= 1350)
  // A corner is the dark background; the middle is paper (or ink).
  assert.ok(rgb[0] < 40 && rgb[1] < 40)
  const mid = ((height >> 1) * width + (width >> 1)) * 3
  assert.ok(rgb[mid] > 30)
  assert.ok(png.length < 1024 * 1024, `PNG is ${png.length} bytes`)
})

test('--short renders a 4:5 canvas and drops the detail sections', () => {
  const stats = buildStats(demoScan(), { period: allTime(DEMO_NOW), now: DEMO_NOW, demo: true })
  const receipt = buildReceipt(stats, { short: true })
  const text = receipt.lines.map((l) => ('text' in l ? l.text : 'name' in l ? l.name : '')).join('\n')
  for (const gone of ['BY MODEL', 'CACHE READ', 'AGENT REPLIES', '  Bash', 'LONGEST STREAK']) {
    assert.ok(!text.includes(gone), `short receipt still has ${gone}`)
  }
  for (const kept of ['SESSIONS', 'TOOL CALLS', 'TOKENS', 'BY HARNESS', 'TOTAL', 'THANK YOU', 'DEMO']) {
    assert.ok(text.includes(kept), `short receipt lost ${kept}`)
  }
  const { width, height } = decode(renderReceiptPng(receipt))
  assert.ok(Math.abs(width / height - 0.8) < 0.002, `aspect ${width}x${height}`)
})
