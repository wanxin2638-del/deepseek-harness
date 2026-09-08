import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeFixtureSafely, unlinkFixtureLinks } from './test-fixture-cleanup.ts'

const installer = fileURLToPath(new URL('./install-translation-pairing.mjs', import.meta.url))
const pairingMergeDriver = 'scripts/merge-translation-pairing-driver.sh %O %A %B %P'
const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url))
const tsxPackageDirectory = dirname(fileURLToPath(import.meta.resolve('tsx/package.json')))
const fixtures: string[] = []

interface Fixture {
  container: string
  env: NodeJS.ProcessEnv
  linked: string
  main: string
}

interface CommandResult {
  status: number | null
  stderr: string
  stdout: string
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeFixtureSafely(fixture)
})

function commandResult(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

function gitResult(fixture: Fixture, cwd: string, args: string[]): CommandResult {
  return commandResult('git', args, cwd, fixture.env)
}

function git(fixture: Fixture, cwd: string, args: string[]): string {
  const result = gitResult(fixture, cwd, args)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function installPairingProbeFixture(root: string): void {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(scriptsDirectory, join(root, 'scripts'), linkType)
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(tsxPackageDirectory, join(root, 'node_modules/tsx'), linkType)
}

function createFixture(): Fixture {
  const container = mkdtempSync(join(tmpdir(), 'dsh-translation-pairing-'))
  fixtures.push(container)
  const main = join(container, 'main')
  const linked = join(container, 'linked')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'false',
    GITHUB_ACTIONS: 'false',
    GIT_AUTHOR_EMAIL: 'translation-pairing@example.test',
    GIT_AUTHOR_NAME: 'Translation Pairing Test',
    GIT_COMMITTER_EMAIL: 'translation-pairing@example.test',
    GIT_COMMITTER_NAME: 'Translation Pairing Test',
    GIT_CONFIG_GLOBAL: join(container, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: container,
    XDG_CONFIG_HOME: join(container, '.config'),
  }
  const fixture = { container, env, linked, main }
  mkdirSync(main)
  git(fixture, container, ['init', main])
  write(join(main, 'README.md'), '# fixture\n')
  git(fixture, main, ['add', 'README.md'])
  git(fixture, main, ['commit', '-m', 'fixture'])
  git(fixture, main, ['worktree', 'add', '-b', 'linked', linked])
  installPairingProbeFixture(main)
  installPairingProbeFixture(linked)
  return fixture
}

function commonDirectory(fixture: Fixture): string {
  const output = git(fixture, fixture.main, ['rev-parse', '--git-common-dir'])
  return isAbsolute(output) ? output : resolve(fixture.main, output)
}

function runInstaller(
  fixture: Fixture,
  root: string,
  extraEnv: NodeJS.ProcessEnv = {},
): CommandResult {
  const result = spawnSync(process.execPath, [installer], {
    cwd: root,
    env: { ...fixture.env, ...extraEnv },
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

describe('translation-pairing installer', { timeout: 90_000 }, () => {
  it('configures the merge driver separately for each worktree', () => {
    const fixture = createFixture()

    const results = [
      runInstaller(fixture, fixture.main),
      runInstaller(fixture, fixture.linked),
    ]

    for (const result of results) expect(result.status, result.stderr).toBe(0)
    for (const root of [fixture.main, fixture.linked]) {
      expect(git(fixture, root, ['config', '--worktree', '--get', 'merge.dsh-translation-pairing.name'])).toBe(
        'DeepSeek Harness bilingual pairing records',
      )
      expect(git(fixture, root, ['config', '--worktree', '--get', 'merge.dsh-translation-pairing.driver'])).toBe(
        pairingMergeDriver,
      )
      expect(gitResult(fixture, root, ['config', '--get', 'core.hooksPath']).status).toBe(1)
    }

    const common = commonDirectory(fixture)
    expect(git(fixture, fixture.main, ['config', '--file', join(common, 'config'), '--get', 'core.repositoryFormatVersion'])).toBe('1')
    expect(git(fixture, fixture.main, ['config', '--file', join(common, 'config'), '--get', 'extensions.worktreeConfig'])).toBe('true')
  })

  it('does not replace a custom worktree merge driver', () => {
    const fixture = createFixture()
    const commonConfig = join(commonDirectory(fixture), 'config')
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'core.repositoryFormatVersion', '1'])
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'extensions.worktreeConfig', 'true'])
    git(fixture, fixture.main, [
      'config', '--worktree', 'merge.dsh-translation-pairing.driver', 'custom-driver %A',
    ])

    const result = runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to replace worktree merge.dsh-translation-pairing.driver')
    expect(git(fixture, fixture.main, [
      'config', '--worktree', '--get', 'merge.dsh-translation-pairing.driver',
    ])).toBe('custom-driver %A')
  })

  it('does not publish configuration when the driver probe fails', () => {
    const fixture = createFixture()
    unlinkFixtureLinks(fixture.main)

    const result = runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('merge-translation-pairing.ts --probe failed')
    expect(gitResult(fixture, fixture.main, [
      'config', '--get', 'merge.dsh-translation-pairing.driver',
    ]).status).toBe(1)
  })

  it('skips configuration during automated jobs', () => {
    const fixture = createFixture()

    const result = runInstaller(fixture, fixture.main, { CI: 'true' })

    expect(result.status, result.stderr).toBe(0)
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
    expect(gitResult(fixture, fixture.main, [
      'config', '--get', 'merge.dsh-translation-pairing.driver',
    ]).status).toBe(1)
    expect(existsSync(join(commonDirectory(fixture), 'config.worktree'))).toBe(false)
  })
})
