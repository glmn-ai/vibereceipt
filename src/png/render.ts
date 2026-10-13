// Rasterises the receipt into a PNG: a strip of thermal paper with torn
// zigzag edges and a soft shadow on a dark background, printed in the Spleen
// bitmap font at 2x so every font pixel stays crisp.
import type { Line, Receipt } from '../receipt/model.js'
import { lineText, WIDTH } from '../receipt/model.js'
import { barcodeUnits } from '../receipt/barcode.js'
import { encodePng } from './encode.js'
import { SPLEEN_16X32, SPLEEN_8X16 } from './fontData.js'

interface Font {
  width: number
  height: number
  glyphs: Record<number, string>
}

/** Device pixels per font pixel. */
const SCALE = 2
const CELL_W = SPLEEN_8X16.width * SCALE // 16
const CELL_H = SPLEEN_8X16.height * SCALE // 32
const LINE_H = CELL_H + 6
const BIG_W = SPLEEN_16X32.width * SCALE // 32
const BIG_H = SPLEEN_16X32.height * SCALE // 64
const BIG_LINE_H = BIG_H + 14
const BLANK_H = Math.round(LINE_H * 0.6)
const BARCODE_H = 84

const CANVAS_W = 1080
const CONTENT_W = WIDTH * CELL_W // 704
const PAPER_PAD_X = 60
const PAPER_W = CONTENT_W + PAPER_PAD_X * 2 // 824
const PAPER_PAD_TOP = 70
const PAPER_PAD_BOTTOM = 64
const TOOTH_W = 22
const TOOTH_D = 11
const MARGIN_TOP = 104
const MARGIN_BOTTOM = 132
const MIN_H = 1350 // 4:5 at 1080 wide

type RGB = [number, number, number]
const PAPER: RGB = [244, 240, 231]
const INK: RGB = [33, 31, 30]
const BG_TOP: RGB = [27, 27, 33]
const BG_BOTTOM: RGB = [13, 13, 16]
const FOOT: RGB = [112, 112, 124]

/** 4x4 ordered-dither thresholds: smooth gradients that still compress well. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Deterministic per-pixel noise in [0, 1). */
function hash(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

class Canvas {
  readonly rgb: Uint8Array
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.rgb = new Uint8Array(width * height * 3)
  }

  set(x: number, y: number, c: RGB): void {
    const i = (y * this.width + x) * 3
    this.rgb[i] = c[0]
    this.rgb[i + 1] = c[1]
    this.rgb[i + 2] = c[2]
  }

  /** Blends `c` over the pixel with coverage `a` (0..1). */
  blend(x: number, y: number, c: RGB, a: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return
    const i = (y * this.width + x) * 3
    const k = Math.min(1, a)
    this.rgb[i] = Math.round(this.rgb[i] + (c[0] - this.rgb[i]) * k)
    this.rgb[i + 1] = Math.round(this.rgb[i + 1] + (c[1] - this.rgb[i + 1]) * k)
    this.rgb[i + 2] = Math.round(this.rgb[i + 2] + (c[2] - this.rgb[i + 2]) * k)
  }
}

/** Height of the printed content (between the paper paddings). */
function lineHeight(line: Line): number {
  if (line.kind === 'blank') return BLANK_H
  if (line.kind === 'barcode') return BARCODE_H + 12
  if ((line.kind === 'text' || line.kind === 'item') && line.big) return BIG_LINE_H
  return LINE_H
}

/** Triangle wave for the torn edge: 0 at a tooth's tip, TOOTH_D at its root. */
function tooth(x: number): number {
  const t = (((x % TOOTH_W) + TOOTH_W) % TOOTH_W) / TOOTH_W
  return Math.abs(t - 0.5) * 2 * TOOTH_D
}

interface Ink {
  /** Ink strength 0..1 (dim text prints lighter). */
  density: number
  bold: boolean
}

class Printer {
  constructor(private readonly canvas: Canvas) {}

  /** Thermal-head density: a faint per-column variation plus grain. */
  private inkAlpha(x: number, y: number, ink: Ink): number {
    const head = 0.93 + 0.07 * hash(x, 0, 7)
    const grain = 0.86 + 0.14 * hash(x >> 1, y >> 1, 3)
    return ink.density * head * grain
  }

  glyph(font: Font, scale: number, code: number, x0: number, y0: number, ink: Ink): void {
    const hex = font.glyphs[code] ?? font.glyphs[63]
    if (!hex) return
    const digits = Math.ceil(font.width / 4)
    for (let row = 0; row < font.height; row++) {
      const bits = parseInt(hex.slice(row * digits, (row + 1) * digits), 16)
      if (!bits) continue
      for (let col = 0; col < font.width; col++) {
        if (!((bits >> (font.width - 1 - col)) & 1)) continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale + (ink.bold ? (font.width > 8 ? 2 : 1) : 0); dx++) {
            const x = x0 + col * scale + dx
            const y = y0 + row * scale + dy
            this.canvas.blend(x, y, INK, this.inkAlpha(x, y, ink))
          }
        }
      }
    }
  }

  text(text: string, x: number, y: number, ink: Ink, big = false): void {
    const font = big ? SPLEEN_16X32 : SPLEEN_8X16
    const advance = big ? BIG_W : CELL_W
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code !== 32) this.glyph(font, SCALE, code, x + i * advance, y, ink)
    }
  }

  barcode(seed: string, centerX: number, y: number): void {
    const units = barcodeUnits(seed)
    const unit = 6
    const x0 = Math.round(centerX - (units.length * unit) / 2)
    const ink: Ink = { density: 1, bold: false }
    units.forEach((on, i) => {
      if (!on) return
      for (let dx = 0; dx < unit; dx++) {
        for (let dy = 0; dy < BARCODE_H; dy++) {
          const x = x0 + i * unit + dx
          this.canvas.blend(x, y + dy, INK, this.inkAlpha(x, y + dy, ink))
        }
      }
    })
  }
}

/** Box blur of a float mask, separable, `passes` times (≈ gaussian). */
function blur(mask: Float32Array, width: number, height: number, radius: number, passes = 3): void {
  const tmp = new Float32Array(mask.length)
  const window = radius * 2 + 1
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      const row = y * width
      let sum = 0
      for (let x = -radius; x <= radius; x++) sum += mask[row + Math.min(width - 1, Math.max(0, x))]
      for (let x = 0; x < width; x++) {
        tmp[row + x] = sum / window
        sum += mask[row + Math.min(width - 1, x + radius + 1)] - mask[row + Math.max(0, x - radius)]
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x]
      for (let y = 0; y < height; y++) {
        mask[y * width + x] = sum / window
        sum +=
          tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x]
      }
    }
  }
}

export function renderReceiptPng(receipt: Receipt): Buffer {
  const contentH = receipt.lines.reduce((sum, line) => sum + lineHeight(line), 0)
  const paperH = PAPER_PAD_TOP + contentH + PAPER_PAD_BOTTOM
  const naturalH = MARGIN_TOP + paperH + MARGIN_BOTTOM
  // Full receipt: 1080 wide, as tall as it needs (at least 4:5). Short
  // receipt: the canvas widens to an exact 4:5 so the timeline shows it whole.
  const height = Math.max(MIN_H, naturalH)
  const width = receipt.short ? Math.max(CANVAS_W, Math.round((height * 4) / 5)) : CANVAS_W
  const canvas = new Canvas(width, height)
  const paperX = Math.round((width - PAPER_W) / 2)
  const paperY = Math.round((height - paperH - (MARGIN_BOTTOM - MARGIN_TOP)) / 2)

  // Paper shape (with torn top and bottom).
  const inPaper = (x: number, y: number): boolean => {
    if (x < paperX || x >= paperX + PAPER_W) return false
    const local = x - paperX
    return y >= paperY + tooth(local) && y < paperY + paperH - tooth(local + TOOTH_W / 2)
  }

  // Background: vertical gradient, a soft glow behind the paper, dithered.
  const cx = width / 2
  const cy = paperY + paperH * 0.42
  const glowR = Math.max(width, height) * 0.62
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1)
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, (y - cy) * 0.8) / glowR
      const glow = Math.max(0, 1 - d) ** 2 * 16
      const dither = BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.47
      canvas.set(x, y, [
        Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t + glow + dither),
        Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t + glow + dither),
        Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t + glow * 1.15 + dither)
      ])
    }
  }

  // Shadow: the paper's silhouette, offset down, blurred, darkened under it.
  {
    const shadowOffset = 26
    const shadow = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (inPaper(x, y - shadowOffset)) shadow[y * width + x] = 1
      }
    }
    blur(shadow, width, height, 18)
    for (let i = 0; i < shadow.length; i++) {
      const a = shadow[i] * 0.62
      if (a > 0.002) canvas.blend(i % width, Math.floor(i / width), [0, 0, 0], a)
    }
  }

  // Paper: warm off-white, faint grain, slightly darker toward the edges.
  for (let y = paperY; y < paperY + paperH; y++) {
    for (let x = paperX; x < paperX + PAPER_W; x++) {
      if (!inPaper(x, y)) continue
      const edge = Math.min(x - paperX, paperX + PAPER_W - 1 - x) / PAPER_W
      const shade = edge < 0.06 ? (0.06 - edge) * 0.45 : 0
      // Sparse specks instead of full noise: the same paper feel, a third of the PNG size.
      const grain = hash(x >> 1, y >> 1, 5) < 0.22 ? -2 : 0
      const k = 1 - shade
      canvas.set(x, y, [
        Math.round(PAPER[0] * k + grain),
        Math.round(PAPER[1] * k + grain),
        Math.round(PAPER[2] * k + grain - 1)
      ])
    }
  }

  // Print.
  const printer = new Printer(canvas)
  const left = paperX + PAPER_PAD_X
  let y = paperY + PAPER_PAD_TOP
  for (const line of receipt.lines) {
    const h = lineHeight(line)
    if (line.kind === 'barcode') {
      printer.barcode(line.seed, paperX + PAPER_W / 2, y + 4)
    } else if (line.kind === 'rule') {
      printer.text(line.char.repeat(WIDTH), left, y, { density: 0.55, bold: false })
    } else if (line.kind !== 'blank') {
      const ink: Ink = { density: line.dim ? 0.5 : 1, bold: Boolean(line.bold) }
      if (line.big && line.kind === 'text') {
        const t = line.text.slice(0, Math.floor(CONTENT_W / BIG_W))
        printer.text(t, left + Math.round((CONTENT_W - t.length * BIG_W) / 2), y + 4, ink, true)
      } else if (line.big && line.kind === 'item') {
        const amount = line.amount ?? line.qty
        const maxCells = Math.floor(CONTENT_W / BIG_W)
        if (line.name.length + 1 + amount.length <= maxCells) {
          printer.text(line.name, left, y + 4, ink, true)
          printer.text(amount, left + CONTENT_W - amount.length * BIG_W, y + 4, ink, true)
        } else {
          printer.text(line.name, left, y + 4 + (BIG_H - CELL_H) / 2, ink)
          printer.text(amount, left + CONTENT_W - amount.length * BIG_W, y + 4, ink, true)
        }
      } else {
        printer.text(lineText(line, () => ''), left, y, ink)
      }
    }
    y += h
  }

  // Under the paper: how to get your own.
  const foot = 'npx vibereceipt'
  const footY = paperY + paperH + Math.round((MARGIN_BOTTOM - CELL_H) / 2) + 6
  const footX = Math.round((width - foot.length * CELL_W) / 2)
  for (let i = 0; i < foot.length; i++) {
    const code = foot.charCodeAt(i)
    const hex = SPLEEN_8X16.glyphs[code]
    if (!hex || code === 32) continue
    for (let row = 0; row < 16; row++) {
      const bits = parseInt(hex.slice(row * 2, row * 2 + 2), 16)
      for (let col = 0; col < 8; col++) {
        if (!((bits >> (7 - col)) & 1)) continue
        for (let dy = 0; dy < SCALE; dy++)
          for (let dx = 0; dx < SCALE; dx++)
            canvas.blend(footX + i * CELL_W + col * SCALE + dx, footY + row * SCALE + dy, FOOT, 1)
      }
    }
  }

  return encodePng(width, height, canvas.rgb)
}
