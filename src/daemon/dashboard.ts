import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HTML = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  // tsx (dev): src/daemon/ → ../dashboard/index.html
  // built (dist/daemon/): dist/daemon/ → ../dashboard/index.html
  const candidates = [
    join(here, '../dashboard/index.html'),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf8') } catch {}
  }
  return '<!doctype html><html><body><h1>agent-wire</h1><p>dashboard html missing</p></body></html>'
})()

export function renderDashboard(): string { return HTML }
