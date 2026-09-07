import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface BackendLaunchSpec {
  command: string
  args: string[]
  cwd: string
}

export interface BackendHandle {
  child: ChildProcess
  url: string
}

const READY_PREFIX = /^dsh web: /
const URL_TOKEN = /https?:\/\/\S+/

export const READY_TIMEOUT_MS = 60_000

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

export function extractReadyUrl(line: string): string | undefined {
  if (!READY_PREFIX.test(line)) return undefined
  const token = line.match(URL_TOKEN)?.[0]
  if (token === undefined || !isLoopbackUrl(token)) return undefined
  return token
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export interface BackendOptions {
  spec: BackendLaunchSpec
  env: NodeJS.ProcessEnv
  onLog: (chunk: string) => void
  onReady: (url: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

export interface BackendSession {
  handle: BackendHandle
  ready: Promise<string>
  dispose: () => void
}

export function startBackend(options: BackendOptions): BackendSession {
  const child = spawn(options.spec.command, options.spec.args, {
    cwd: options.spec.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  let errorBuffer = ''
  let settled = false
  let disposed = false

  const ready = new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      reject(new Error(`backend did not print a ready URL within ${READY_TIMEOUT_MS / 1000}s`))
    }, READY_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      options.onLog(chunk)
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const url = extractReadyUrl(line)
        if (url !== undefined && !settled) {
          settled = true
          clearTimeout(timer)
          options.onReady(url)
          resolveReady(url)
          return
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      options.onLog(chunk)
      errorBuffer += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      options.onExit(code, signal)
      // An exit before readiness and not caused by dispose is a startup
      // failure (e.g. the requested --port is taken): surface it to the shell
      // instead of letting the window vanish silently.
      if (settled || disposed) return
      settled = true
      clearTimeout(timer)
      const tail = [...buffer.split(/\r?\n/), ...errorBuffer.split(/\r?\n/)].slice(-8).join('\n')
      reject(new Error(`backend exited with code ${code ?? 'n/a'} before readiness${tail.length > 0 ? `:\n${tail}` : ''}`))
    })
  })

  const dispose = () => {
    disposed = true
    if (child.exitCode === null && child.signalCode === null) killTree(child)
  }

  return { handle: { child, url: '' }, ready, dispose }
}

/** Resolve the system node runtime that hosts the backend in dev mode. */
export function systemNodePath(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.npm_node_execpath
  if (direct !== undefined && direct.length > 0 && direct !== 'node') return direct
  if (process.platform === 'win32') {
    const found = spawnSync('where', ['node'], { stdio: ['ignore', 'pipe', 'ignore'] })
    if (found.status === 0) {
      const first = found.stdout.toString().split(/\r?\n/).find(line => line.trim().length > 0)
      if (first !== undefined) return first.trim()
    }
  } else {
    const found = spawnSync('which', ['node'], { stdio: ['ignore', 'pipe', 'ignore'] })
    if (found.status === 0) {
      const resolved = found.stdout.toString().trim()
      if (resolved.length > 0) return resolved
    }
  }
  return 'node'
}

/**
 * The assembled closure launch: `<runtimeRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js`
 * run from a cwd detached from the repository. `runtimeRoot` is the dev staging
 * (apps/desktop/.runtime) or the packaged resources/dsh-runtime. The web profile
 * needs no extra node flags: the bin is compiled ESM (F7).
 * @param runtimeRoot - directory holding node_modules with the @deepseek-ai/dsh closure.
 * @param nodePath - absolute node executable hosting the backend.
 * @param port - `0` for an OS-assigned port (D3), or a shell-level override for debugging.
 */
export function assembledLaunchSpec(runtimeRoot: string, nodePath: string, port: number = 0): BackendLaunchSpec {
  const bin = resolve(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) {
    throw new Error(
      `backend runtime entry missing at ${bin}; run pnpm --filter @deepseek-ai/dsh-desktop assemble first`,
    )
  }
  return {
    command: nodePath,
    args: [bin, '--profile', 'web', '--no-open', '--port', String(port)],
    cwd: runtimeRoot,
  }
}
