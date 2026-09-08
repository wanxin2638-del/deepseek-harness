/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path; the fold is the
 * `sandboxMode` session-projection unit registered here, while the event and
 * write path come from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath, type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'
import type { SandboxWritableRoots } from './types.ts'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'
export type * from './types.ts'

/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

/** Resolve one user-entered root and require an existing directory. */
async function resolveWritableRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`sandbox writable root must be an absolute path: ${path}`)
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch (error: unknown) {
    throw new Error(`sandbox writable root is unavailable: ${path}`, { cause: error })
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch (error: unknown) {
    throw new Error(`sandbox writable root cannot be inspected: ${path}`, { cause: error })
  }
  if (!info.isDirectory()) throw new Error(`sandbox writable root is not a directory: ${path}`)
  return resolveWorkspaceRoot(resolved)
}

/** Normalize a removal request without requiring the directory to still exist. */
function normalizeWritableRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error(`sandbox writable root must be an absolute path: ${path}`)
  return resolveWorkspaceRoot(path)
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  const extraRoots = policy.extraWritableRoots ?? []
  const extraText = extraRoots.length === 0
    ? ''
    : ` Additional authorized directories: ${JSON.stringify(extraRoots)}.`
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}.${extraText} Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-mode override, or null before one (deployment default applies at resolve time). */
    sandboxMode: SandboxModeState
  }
}

const writableRootsStateSchema = zod.array(zod.string())

function applyWritableRootEvent(
  state: string[],
  event: SessionEvent,
): string[] {
  if (event.type !== 'sandbox/writable-root') return state
  if (event.data.action === 'add') {
    return state.includes(event.data.path) ? state : [...state, event.data.path]
  }
  return state.includes(event.data.path)
    ? state.filter(path => path !== event.data.path)
    : state
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })
    ctx.sessionProjections.register({
      key: 'sandboxWritableRoots',
      stateVersion: 1,
      stateSchema: writableRootsStateSchema,
      init: () => [],
      apply: applyWritableRootEvent,
      wire: { viewSchema: writableRootsStateSchema, view: state => state },
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'sandbox-path',
        description: 'Add or remove an additional writable directory for this session',
        input: { hint: '<add|remove> <absolute directory>' },
        recordInput: false,
        handler: async ({ agent, rawInput }) => {
          const match = /^(add|remove)\s+(.+)$/su.exec(rawInput.trim())
          if (match === null || (match[1] !== 'add' && match[1] !== 'remove') || match[2] === undefined) {
            return { kind: 'error', text: 'usage: /sandbox-path <add|remove> <absolute directory>' }
          }
          const path = match[2].trim()
          try {
            if (match[1] === 'add') {
              const committed = await this.addWritableRoot(agent.session, path)
              return { kind: 'success', text: `additional writable directory ${committed}` }
            }
            const removed = this.removeWritableRoot(agent.session, path)
            return {
              kind: 'success',
              text: removed ? `removed additional writable directory ${normalizeWritableRoot(path)}` : 'additional writable directory was not present',
            }
          } catch (error: unknown) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const extraWritableRoots = session === undefined ? [] : this.writableRootsOf(session)
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...session === undefined ? {} : { sessionId: session.id },
      ...extraWritableRoots.length === 0 ? {} : { extraWritableRoots },
    }
  }

  /**
   * Read the session's canonical additional writable roots.
   * @param session - session whose additional roots are read.
   * @returns canonical additional writable roots in user-maintained order.
   */
  private writableRootsOf(session: Session): SandboxWritableRoots {
    const roots = this.ctx.sessionProjections.stateOf(session, 'sandboxWritableRoots')
    if (roots === undefined) throw new Error('sandbox: sandboxWritableRoots projection is not registered')
    return roots
  }

  /**
   * Add one existing directory to the session's additional writable roots.
   * @param session - session receiving the durable root grant.
   * @param path - absolute existing directory to grant.
   * @returns the canonical directory path recorded in the event.
   */
  private async addWritableRoot(session: Session, path: string): Promise<string> {
    const normalized = await resolveWritableRoot(path)
    if (!this.writableRootsOf(session).includes(normalized)) {
      session.append('sandbox/writable-root', { action: 'add', path: normalized })
    }
    return normalized
  }

  /**
   * Remove one additional writable directory from the session.
   * @param session - session whose durable root grant is changed.
   * @param path - absolute directory path to remove.
   * @returns `true` when a grant was removed, or `false` when it was absent.
   */
  private removeWritableRoot(session: Session, path: string): boolean {
    const normalized = normalizeWritableRoot(path)
    if (!this.writableRootsOf(session).includes(normalized)) return false
    session.append('sandbox/writable-root', { action: 'remove', path: normalized })
    return true
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }
}

export default SandboxPolicyService
