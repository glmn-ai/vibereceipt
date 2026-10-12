// Prints the receipt like a thermal printer: line by line, a few ms apart.
import type { Line, Receipt } from './model.js'
import { lineText, WIDTH } from './model.js'
import { barcodeText } from './barcode.js'

export interface TerminalOptions {
  color: boolean
  animate: boolean
  /** ms between lines when animating. */
  lineDelay?: number
  /** Plain ASCII barcode (for terminals without block characters). */
  ascii?: boolean
  write?: (text: string) => void
}

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

export function styledLine(line: Line, color: boolean, ascii = false): string {
  const text = lineText(line, (seed) => barcodeText(seed, WIDTH, ascii))
  if (!color) return text
  const bold = (line.kind === 'text' || line.kind === 'item') && line.bold
  const dim = (line.kind === 'text' || line.kind === 'item') && line.dim
  if (line.kind === 'rule') return `${DIM}${text}${RESET}`
  if (bold) return `${BOLD}${text}${RESET}`
  if (dim) return `${DIM}${text}${RESET}`
  return text
}

/** The receipt as one string (no animation). */
export function receiptToText(receipt: Receipt, color = false, ascii = false): string {
  return receipt.lines.map((line) => styledLine(line, color, ascii)).join('\n')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function printReceipt(receipt: Receipt, options: TerminalOptions): Promise<void> {
  const write = options.write ?? ((text: string) => process.stdout.write(text))
  const margin = '  '
  write('\n')
  for (const line of receipt.lines) {
    write(`${margin}${styledLine(line, options.color, options.ascii)}\n`)
    if (options.animate) await sleep(options.lineDelay ?? 14)
  }
  write('\n')
}
