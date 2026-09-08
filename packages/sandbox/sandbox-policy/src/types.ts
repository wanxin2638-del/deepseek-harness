/** Pure client/host types for the session's additional sandbox roots. */

/** Canonical directory roots granted in addition to the Session workspace. */
export type SandboxWritableRoots = readonly string[]

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Canonical additional writable roots, in user-maintained order. */
    sandboxWritableRoots: SandboxWritableRoots
  }

  interface SessionProjectionMap {
    /** Canonical additional writable roots, in user-maintained order. */
    sandboxWritableRoots: SandboxWritableRoots
  }
}
