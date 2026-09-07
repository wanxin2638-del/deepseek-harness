/**
 * Stage the dsh web-profile backend closure into apps/desktop/.runtime for the
 * desktop shell. The deploy root (apps/desktop/deploy-root) declares the exact
 * workspace closure; pnpm deploy copies it into a flat, symlink-free payload
 * that the shell spawns instead of the repo source tree.
 *
 * The ABI probe (D2 decision) launches the staged bin under each candidate
 * node runtime, waits for the `dsh web:` ready line, verifies GET / answers
 * 401, and kills the tree. Route and post-deploy steps mirror
 * scripts/build-exe-for-python-sdk.ts; only the closure manifest and payload
 * layout differ. See docs/plans/desktop-shell.md P1.4.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..', '..', '..')
const runtimeDir = resolve(root, 'apps/desktop/.runtime')
const nodeRuntimeDir = resolve(root, 'apps/desktop/.runtime-node')
// The packaging payload nests the closure under dsh-runtime/: electron-builder
// hard-excludes a root-level node_modules from extraResources (filter.js), so
// the flat development layout can never be packaged as-is.
const packDir = resolve(root, 'apps/desktop/.runtime-pack')
const probeHome = resolve(root, 'apps/desktop/.runtime-probe-home')
const deploySourceNodeModules = resolve(root, 'apps/desktop/deploy-root/node_modules')
const deployRootManifest = resolve(root, 'apps/desktop/deploy-root/package.json')
const entryBin = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const frontendDist = 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'

const DEPLOY_FLAGS = [
  '--legacy',
  '--prod',
  '--config.node-linker=hoisted',
  '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true',
]

const PROBE_TIMEOUT_MS = 45_000
const READY_PATTERN = /dsh web: https?:\/\/127\.0\.0\.1:\d+\/\?token=/

/** Resolve pnpm to a spawnable command: its JS entrypoint under Node when pnpm runs us. */
function pnpmInvocation(args) {
  const entrypoint = process.env.npm_execpath?.trim()
  if (entrypoint !== undefined && entrypoint !== '') {
    const extension = entrypoint.split('.').pop()?.toLowerCase()
    if (extension === 'js' || extension === 'cjs' || extension === 'mjs') return [process.execPath, [entrypoint, ...args]]
    if (extension !== 'cmd') return [entrypoint, args]
  }
  if (process.platform === 'win32') throw new Error('assemble: pnpm must expose a JavaScript entrypoint through npm_execpath on Windows.')
  return ['pnpm', args]
}

function run(label, command, args) {
  console.log(`assemble: ${label}: ${[command, ...args].map(part => part.includes(' ') ? JSON.stringify(part) : part).join(' ')}`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      // Artifact builds must not mutate or validate a developer's Git hooks.
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', (error) => reject(new Error(`assemble: ${label} failed to spawn: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) return resolvePromise()
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`assemble: ${label} failed (${cause})`))
    })
  })
}

function runPnpm(label, args) {
  const [command, invocationArgs] = pnpmInvocation(args)
  return run(label, command, invocationArgs)
}

async function sizeOnDisk(directory) {
  let total = 0
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const st = statSync(full, { throwIfNoEntry: false })
        if (st !== undefined) total += st.size
      }
    }
  }
  await walk(directory)
  return total
}

/**
 * Fail before any cleanup if the build artifacts the closure depends on are
 * missing. Every manifest workspace package must have published its lib/ (or
 * its dist/ for the web frontend), and the entry bin must exist.
 */
async function checkPrerequisites() {
  const manifest = JSON.parse(await readFile(deployRootManifest, 'utf8'))
  const missing = []
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    if (name === '@deepseek-ai/dsh-web-frontend') {
      if (!existsSync(resolve(root, 'apps/web/dist/index.html'))) missing.push('apps/web/dist/index.html (run pnpm run build:web)')
      continue
    }
    const packagePath = workspacePackagePath(name)
    if (packagePath === undefined) {
      missing.push(`${name}: not a workspace package`)
      continue
    }
    if (!existsSync(resolve(root, packagePath, 'lib'))) missing.push(`${packagePath}/lib (run pnpm run build)`)
  }
  if (!existsSync(resolve(root, 'apps/cli/lib/bin.js'))) missing.push('apps/cli/lib/bin.js (run pnpm run build)')
  if (missing.length > 0) {
    throw new Error(`assemble: prerequisite build artifacts missing:\n  ${missing.join('\n  ')}`)
  }
}

/** Name-to-directory map for every workspace package, read from its manifest. */
function buildWorkspaceMap() {
  const map = new Map()
  const scan = (base) => {
    for (const entry of readdirSync(resolve(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = resolve(root, base, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const name = readManifest(manifestPath).name
      if (typeof name === 'string') map.set(name, join(base, entry.name))
    }
  }
  for (const group of readdirSync(resolve(root, 'packages'), { withFileTypes: true })) {
    if (group.isDirectory()) scan(join('packages', group.name))
  }
  scan('vendor')
  scan('apps')
  return map
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Resolve a workspace package name to its repo-relative directory. */
function workspacePackagePath(name) {
  if (workspaceMap === undefined) throw new Error('assemble: workspace map not initialized')
  return workspaceMap.get(name)
}

const workspaceMap = buildWorkspaceMap()

/** Nested node_modules at any depth below a copy root never belong in the flat payload. */
function payloadExcludesNodeModules(copyRoot, path) {
  const relative = path.slice(copyRoot.length + 1)
  return !relative.split(sep).includes('node_modules')
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target. The deploy manifest supplies every peer, so
 * package-local node_modules are omitted to keep one flat Cordis instance.
 */
async function restoreLegacyHoists() {
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8'))
  const restored = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(runtimeDir, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(deploySourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`assemble: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => payloadExcludesNodeModules(source, path),
    })
    restored.push(dependency)
  }
  const stillMissing = Object.keys(manifest.dependencies ?? {})
    .filter(dependency => !existsSync(join(runtimeDir, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(`assemble: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
  }
  if (restored.length > 0) console.log(`assemble: restored legacy deploy hoists: ${restored.join(', ')}`)
}

/** Replace deploy-time package links with real files and reject any remaining link. */
async function materializeStagedLinks() {
  const nodeModules = join(runtimeDir, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => payloadExcludesNodeModules(source, path),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Clear, deploy, and fix up the runtime payload. */
async function deploy() {
  if (runtimeDir === root || root.startsWith(runtimeDir + sep)) {
    throw new Error(`assemble: refusing to clear .runtime ${runtimeDir}: it contains the repo root.`)
  }
  await rm(runtimeDir, { recursive: true, force: true })
  try {
    await runPnpm('deploy', ['--filter', 'dsh-desktop-web-runtime-closure', 'deploy', ...DEPLOY_FLAGS, runtimeDir])
  } catch {
    console.log('assemble: network deploy failed; retrying --offline from the pnpm store.')
    await runPnpm('deploy (offline)', ['--filter', 'dsh-desktop-web-runtime-closure', 'deploy', '--offline', ...DEPLOY_FLAGS, runtimeDir])
  }
  await restoreLegacyHoists()
  await materializeStagedLinks()
}

function killTree(child) {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

/**
 * Run one probe: launch the staged bin under `node` from a detached cwd, wait
 * for the `dsh web:` ready line plus a 401 to GET /, then kill the tree. Any
 * ERR_DLOPEN or early exit fails the probe with the captured output.
 * @param node - absolute path to the candidate node runtime.
 * @param env - extra environment (e.g. ELECTRON_RUN_AS_NODE) for the child.
 */
async function probeNode(node, env = {}) {
  const bin = join(runtimeDir, entryBin)
  if (!existsSync(bin)) throw new Error(`assemble: probe target missing ${bin}; run assemble without flags first.`)
  let readyUrl
  await new Promise((resolvePromise, reject) => {
    const child = spawn(node, [bin, '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: runtimeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DSH_HOME: probeHome, ...env },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      reject(new Error(`probe under ${node} timed out without a ready line.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, PROBE_TIMEOUT_MS)

    const finish = (ok, extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      if (ok) resolvePromise()
      else reject(new Error(`probe under ${node} failed.\nstdout:\n${stdout}\nstderr:\n${stderr}\n${extra ?? ''}`))
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      const ready = stdout.match(READY_PATTERN)
      if (ready !== null && readyUrl === undefined) {
        readyUrl = ready[0].split(' ').pop()
        void verifyHttp401(readyUrl).then(
          (status) => finish(status === 401, `GET ${readyUrl} answered ${status}; expected 401`),
          (error) => finish(false, `HTTP check failed: ${error.message}`),
        )
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (/ERR_DLOPEN/.test(stderr)) finish(false, 'native module ABI mismatch (ERR_DLOPEN)')
    })
    child.on('error', (error) => finish(false, error.message))
    child.on('exit', (code) => { if (!settled && readyUrl === undefined) finish(false, `backend exited early with code ${code}`) })
  })
}

/** GET the ready URL without token, expecting the unauthenticated index to reject with 401. */
async function verifyHttp401(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const clean = url.replace(/\/\?token=.*$/, '/')
    const response = await fetch(clean, { redirect: 'manual', signal: controller.signal })
    return response.status
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Stage the standalone node runtime that hosts the backend in the packaged
 * payload (D2). The ABI probe just validated `probeNode` against the exact
 * binary at `process.execPath`, so copying it preserves the validated ABI.
 */
async function stageNodeRuntime() {
  const source = process.execPath
  await rm(nodeRuntimeDir, { recursive: true, force: true })
  await mkdir(nodeRuntimeDir, { recursive: true })
  await cp(source, join(nodeRuntimeDir, 'node.exe'))
  console.log(`assemble: staged backend node runtime ${source} -> ${join(nodeRuntimeDir, 'node.exe')}`)
}

/**
 * Stage the packaging payload: `.runtime/dsh-runtime/` inside `.runtime-pack`.
 * electron-builder's extraResources filter drops a root-level node_modules, so
 * the closure rides one level deeper. A hard-linked copy keeps the 213 MB
 * payload cheap and lets the probe residue (outside `.runtime`) stay out.
 */
async function stagePackPayload() {
  const target = join(packDir, 'dsh-runtime')
  await rm(packDir, { recursive: true, force: true })
  await mkdir(packDir, { recursive: true })
  await cp(runtimeDir, target, { recursive: true, link: true })
  const size = await sizeOnDisk(packDir)
  console.log(`assemble: staged packaging payload at ${packDir} (${(size / (1024 * 1024)).toFixed(1)} MB)`)
}

async function main() {
  const { values } = parseArgs({
    // pnpm forwards a bare `--` before flags; drop those separators.
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    allowPositionals: true,
    options: {
      'skip-probe': { type: 'boolean', default: false },
      'electron-probe': { type: 'boolean', default: false },
    },
  })
  await checkPrerequisites()
  await deploy()
  const bin = join(runtimeDir, entryBin)
  const frontend = join(runtimeDir, frontendDist)
  console.log(`assemble: staged runtime at ${runtimeDir}`)
  console.log(`  bin: ${bin} (${existsSync(bin) ? 'present' : 'MISSING'})`)
  console.log(`  UI dist: ${frontend} (${existsSync(frontend) ? 'present' : 'MISSING'})`)
  console.log(`  total size: ${(await sizeOnDisk(runtimeDir) / (1024 * 1024)).toFixed(1)} MB`)
  await stageNodeRuntime()
  await stagePackPayload()

  if (values['skip-probe']) {
    console.log('assemble: skipping ABI probe (--skip-probe)')
    return
  }
  console.log('assemble: ABI probe under system node:')
  await probeNode(process.execPath)
  console.log('assemble: ABI probe under system node: ready line + 401 confirmed, no ERR_DLOPEN')
  if (values['electron-probe']) {
    const electron = resolve(root, 'apps/desktop/node_modules/electron/dist/electron.exe')
    if (!existsSync(electron)) {
      console.log(`assemble: ${electron} missing; skipping Electron node probe`)
      return
    }
    console.log('assemble: ABI probe under Electron bundled node (ELECTRON_RUN_AS_NODE):')
    try {
      await probeNode(electron, { ELECTRON_RUN_AS_NODE: '1' })
      console.log('assemble: ABI probe under Electron bundled node: ready line + 401 confirmed, no ERR_DLOPEN')
    } catch (error) {
      console.log(`assemble: ABI probe under Electron bundled node FAILED: ${error instanceof Error ? error.message : error}`)
      console.log('assemble: D2 conclusion: ELECTRON_RUN_AS_NODE is ABI-incompatible; ship a standalone node.exe (bundled node fallback)')
    }
  }
}

await main()