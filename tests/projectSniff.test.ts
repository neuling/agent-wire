import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { sniffProject } from '../src/bridge/projectSniff.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'wire-sniff-'))
}

describe('sniffProject', () => {
  it('reads package.json manifest', () => {
    const d = tmp()
    writeFileSync(join(d, 'package.json'), JSON.stringify({
      name: 'foo',
      dependencies: { next: '15.0.0', react: '^19.0.0' },
      devDependencies: { vitest: '~2.1.0' },
    }))
    const c = sniffProject(d)
    expect(c.manifest?.type).toBe('package.json')
    expect(c.manifest?.name).toBe('foo')
    expect(c.manifest?.key_deps).toEqual(expect.arrayContaining(['next@15.0.0', 'react@19.0.0', 'vitest@2.1.0']))
  })

  it('reads git repo info', () => {
    const d = tmp()
    execSync('git init -q && git checkout -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: d })
    const c = sniffProject(d)
    expect(c.repo?.root).toBe(d)
    expect(c.repo?.branch).toBe('main')
  })

  it('handles no repo, no manifest gracefully', () => {
    const d = tmp()
    const c = sniffProject(d)
    expect(c.repo).toBeUndefined()
    expect(c.manifest).toBeUndefined()
  })

  it('reads Gemfile', () => {
    const d = tmp()
    writeFileSync(join(d, 'Gemfile'), `source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'puma'\n`)
    const c = sniffProject(d)
    expect(c.manifest?.type).toBe('Gemfile')
    expect(c.manifest?.key_deps).toContain('rails')
    expect(c.manifest?.key_deps).toContain('puma')
  })

  it('reads pyproject.toml', () => {
    const d = tmp()
    writeFileSync(join(d, 'pyproject.toml'), `[project]\nname = "myproj"\ndependencies = ["fastapi>=0.100", "pydantic>=2"]\n`)
    const c = sniffProject(d)
    expect(c.manifest?.type).toBe('pyproject.toml')
    expect(c.manifest?.name).toBe('myproj')
    expect(c.manifest?.key_deps).toEqual(expect.arrayContaining(['fastapi', 'pydantic']))
  })

  it('reads go.mod', () => {
    const d = tmp()
    writeFileSync(join(d, 'go.mod'), `module example.com/foo\n\ngo 1.22\n`)
    const c = sniffProject(d)
    expect(c.manifest?.type).toBe('go.mod')
    expect(c.manifest?.name).toBe('example.com/foo')
  })

  it('reads Cargo.toml', () => {
    const d = tmp()
    writeFileSync(join(d, 'Cargo.toml'), `[package]\nname = "rusty"\nversion = "0.1.0"\n`)
    const c = sniffProject(d)
    expect(c.manifest?.type).toBe('Cargo.toml')
    expect(c.manifest?.name).toBe('rusty')
  })
})
