// Vendored from @neurosquad/core (MIT) — https://github.com/glmn-ai/neurosquad-cli
// Source: packages/core/src/usage/lineReader.ts at commit 1bc586c20593df20c4c5f9b8489226d06f617a7a
// Copyright (c) 2026 Stanislav Gelman and NeuroSquad contributors. MIT License (see LICENSE-neurosquad-core).
// Read-only copy: do not edit here; change it upstream and re-vendor.

// Incremental, byte-exact reading of an append-only JSONL log.
//
// The logs the Usage section reads are appended to while the harness runs,
// so a scan usually meets a file whose last line is still being written.
// Only COMPLETE lines are consumed: the cursor stops right after the last
// newline, and the unfinished tail is read again, whole, next time. (The
// earlier reader advanced past that tail and so never parsed the line it cut
// in half — one request lost per unlucky scan.)
//
// Splitting happens on the newline BYTE, before decoding: a chunk boundary
// can fall inside a multi-byte UTF-8 character, and decoding each chunk on
// its own would mangle it.
import { open } from 'node:fs/promises'

export interface FileCursor {
  /** File size when last read. */
  size: number
  /** Byte offset just past the last complete line consumed. */
  offset: number
  /** The file's first bytes when last read — a different head means a different file. */
  head?: string
}

export const newCursor = (): FileCursor => ({ size: 0, offset: 0 })

const CHUNK_BYTES = 2 * 1024 * 1024
const HEAD_BYTES = 64
const NEWLINE = 0x0a

export interface ReadResult {
  /** The file was replaced or truncated: everything parsed from it before is void. */
  reset: boolean
  /** Any new complete line was consumed. */
  advanced: boolean
}

/**
 * Feeds every complete line added since `cursor` to `onLine` (without its
 * line break), then moves the cursor. `onReset` runs first when the file
 * turned out to be a different one, so the caller can drop what it parsed. Yields to the event loop between
 * chunks so a first scan of a large history does not freeze the process.
 */
export async function readNewLines(
  path: string,
  cursor: FileCursor,
  onLine: (line: string) => void,
  onReset: () => void,
  yieldBetweenChunks: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve))
): Promise<ReadResult> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const headLength = Math.min(HEAD_BYTES, size)
    const headBuffer = Buffer.alloc(headLength)
    if (headLength > 0) await handle.read(headBuffer, 0, headLength, 0)
    // Hex, not base64: a hex string of a prefix is a prefix of the longer one's.
    const head = headBuffer.toString('hex')
    let reset = false
    const comparable = cursor.head !== undefined && cursor.head.length > 0
    if (
      size < cursor.offset ||
      size < cursor.size ||
      (comparable &&
        cursor.offset > 0 &&
        !head.startsWith(cursor.head as string) &&
        !(cursor.head as string).startsWith(head))
    ) {
      reset = true
      cursor.offset = 0
      onReset()
    }
    cursor.head = head
    let advanced = false
    let position = cursor.offset
    let pending: Buffer = Buffer.alloc(0)
    while (position < size) {
      const length = Math.min(CHUNK_BYTES, size - position)
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead === 0) break
      position += bytesRead
      const data =
        pending.length > 0
          ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead)
      const last = data.lastIndexOf(NEWLINE)
      if (last === -1) {
        pending = data
        continue
      }
      let start = 0
      while (start <= last) {
        const end = data.indexOf(NEWLINE, start)
        let line = data.toString('utf-8', start, end)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length > 0) onLine(line)
        start = end + 1
      }
      pending = data.subarray(last + 1)
      cursor.offset = position - pending.length
      advanced = true
      if (position < size) await yieldBetweenChunks()
    }
    cursor.size = size
    return { reset, advanced }
  } finally {
    await handle.close()
  }
}
