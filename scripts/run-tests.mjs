// Runs every compiled test file with node:test (works on Node 18, 20 and 22+).
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const dir = join('.test-dist', 'test')
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => join(dir, f))
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } })
process.exit(result.status ?? 1)
