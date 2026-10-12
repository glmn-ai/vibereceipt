import { lineText, WIDTH } from './model.js';
import { barcodeText } from './barcode.js';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
export function styledLine(line, color, ascii = false) {
    const text = lineText(line, (seed) => barcodeText(seed, WIDTH, ascii));
    if (!color)
        return text;
    const bold = (line.kind === 'text' || line.kind === 'item') && line.bold;
    const dim = (line.kind === 'text' || line.kind === 'item') && line.dim;
    if (line.kind === 'rule')
        return `${DIM}${text}${RESET}`;
    if (bold)
        return `${BOLD}${text}${RESET}`;
    if (dim)
        return `${DIM}${text}${RESET}`;
    return text;
}
/** The receipt as one string (no animation). */
export function receiptToText(receipt, color = false, ascii = false) {
    return receipt.lines.map((line) => styledLine(line, color, ascii)).join('\n');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function printReceipt(receipt, options) {
    const write = options.write ?? ((text) => process.stdout.write(text));
    const margin = '  ';
    write('\n');
    for (const line of receipt.lines) {
        write(`${margin}${styledLine(line, options.color, options.ascii)}\n`);
        if (options.animate)
            await sleep(options.lineDelay ?? 14);
    }
    write('\n');
}
