import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { AgentContext } from '../daemon/types.js'

export function sniffProject(dir: string): Pick<AgentContext, 'repo' | 'manifest'> {
  const out: Pick<AgentContext, 'repo' | 'manifest'> = {}

  // Resolve symlinks so git root and input dir match on macOS (/var → /private/var)
  let realDir = dir
  try { realDir = realpathSync(dir) } catch {}

  // git
  try {
    // Run git commands in realDir for consistent behaviour; for root, prefer the
    // input `dir` when it resolves to the same path (handles macOS /var symlink).
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd: realDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const branch = execSync('git branch --show-current', { cwd: realDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    let remote: string | undefined
    try {
      remote = execSync('git remote get-url origin', { cwd: realDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {}
    // Use dir (caller's form) when it points to the same real path as the git root
    const root = gitRoot === realDir ? dir : gitRoot
    out.repo = { root, branch: branch || '(detached)', remote }
  } catch {}

  // manifest — first match wins
  const candidates: Array<[string, (p: string) => { type: string; name: string; key_deps: string[] }]> = [
    ['package.json', parsePackageJson],
    ['Gemfile',       parseGemfile],
    ['pyproject.toml', parsePyproject],
    ['Cargo.toml',    parseCargo],
    ['go.mod',        parseGoMod],
  ]
  for (const [file, parse] of candidates) {
    const p = join(realDir, file)
    if (existsSync(p)) {
      try {
        out.manifest = parse(p)
        break
      } catch {}
    }
  }

  return out
}

function parsePackageJson(p: string) {
  const j = JSON.parse(readFileSync(p, 'utf8'))
  const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }
  return {
    type: 'package.json',
    name: j.name ?? '(unnamed)',
    key_deps: Object.entries(deps).slice(0, 8).map(([k, v]) => `${k}@${String(v).replace(/^[\^~]/, '')}`),
  }
}

function parseGemfile(p: string) {
  const src = readFileSync(p, 'utf8')
  const deps = [...src.matchAll(/^\s*gem ['"]([^'"]+)['"]/gm)].map(m => m[1])
  return {
    type: 'Gemfile',
    name: inferDirName(p),
    key_deps: deps.slice(0, 8),
  }
}

function parsePyproject(p: string) {
  const src = readFileSync(p, 'utf8')
  const name = src.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? '(unnamed)'
  // grab dep names from a [project].dependencies = ["pkg>=1", ...] block
  const deps = new Set<string>()
  const depBlock = src.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)
  if (depBlock) {
    for (const m of depBlock[1].matchAll(/"([a-zA-Z0-9_.\-]+)/g)) {
      deps.add(m[1])
    }
  }
  return {
    type: 'pyproject.toml',
    name,
    key_deps: [...deps].slice(0, 8),
  }
}

function parseCargo(p: string) {
  const src = readFileSync(p, 'utf8')
  const name = src.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/)?.[1] ?? '(unnamed)'
  return { type: 'Cargo.toml', name, key_deps: [] }
}

function parseGoMod(p: string) {
  const src = readFileSync(p, 'utf8')
  const name = src.match(/^module\s+(\S+)/m)?.[1] ?? '(unnamed)'
  return { type: 'go.mod', name, key_deps: [] }
}

function inferDirName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? '(unnamed)'
}
