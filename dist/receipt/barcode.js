// A decorative barcode: deterministic bars from the receipt number. It does
// not encode anything a scanner could read (and does not pretend to).
import { createHash } from 'node:crypto';
/** `units` modules, true = ink. Starts and ends with a guard pattern. */
export function barcodeUnits(seed, units = 76) {
    let bytes = createHash('sha256').update(seed).digest();
    let byteIndex = 0;
    const nextWidth = () => {
        if (byteIndex >= bytes.length) {
            bytes = createHash('sha256').update(bytes).digest();
            byteIndex = 0;
        }
        const b = bytes[byteIndex++];
        // Mostly thin, some medium, a few wide — like a real symbol.
        return b < 120 ? 1 : b < 210 ? 2 : 3;
    };
    const guard = [true, false, true, false];
    const out = [...guard];
    let ink = true;
    while (out.length < units - guard.length - 1) {
        const width = Math.min(nextWidth(), units - guard.length - 1 - out.length);
        for (let i = 0; i < width; i++)
            out.push(ink);
        ink = !ink;
    }
    while (out.length < units - guard.length)
        out.push(false);
    out.push(true, false, true, true);
    return out;
}
/** The barcode as terminal text: two modules per cell with half-block characters. */
export function barcodeText(seed, width, ascii = false) {
    const units = barcodeUnits(seed);
    let text = '';
    for (let i = 0; i < units.length; i += 2) {
        const a = units[i];
        const b = units[i + 1] ?? false;
        text += ascii ? (a || b ? '|' : ' ') : a && b ? '█' : a ? '▌' : b ? '▐' : ' ';
    }
    const left = Math.max(0, Math.floor((width - text.length) / 2));
    return ' '.repeat(left) + text;
}
