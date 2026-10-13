import { test } from 'node:test'
import assert from 'node:assert/strict'
import { append } from '../src/scan/collector.js'

test('append takes more items than a spread can (reported on r/ClaudeCode)', () => {
  const big = Array.from({ length: 1_000_000 }, (_, i) => i)
  const target = [-1]
  append(target, big)
  assert.equal(target.length, 1_000_001)
  assert.equal(target[1_000_000], 999_999)
})
