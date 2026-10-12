import { test } from 'node:test'
import assert from 'node:assert/strict'
import { count, duration, tokens } from '../src/format.js'
import { itemText, WIDTH } from '../src/receipt/model.js'

test('number formats', () => {
  assert.equal(count(1234567), '1,234,567')
  assert.equal(tokens(9999), '9,999')
  assert.equal(tokens(12_345), '12.3K')
  assert.equal(tokens(999_950), '1.00M')
  assert.equal(tokens(2_750_000_000), '2.75B')
  assert.equal(duration(5 * 3600_000 + 27 * 60_000), '5H 27M')
  assert.equal(duration(20 * 60_000 + 10_000), '20M')
})

test('item lines are exactly the receipt width', () => {
  const cases: [string, string, string | undefined][] = [
    ['SESSIONS', '176', undefined],
    ['  claude-opus-4-6', '1.50B', '$1,288.95'],
    ['  a-very-long-model-name-that-does-not-fit-at-all', '17.1B', '$123,456.78*']
  ]
  for (const [name, qty, amount] of cases) assert.equal(itemText(name, qty, amount).length, WIDTH)
})
