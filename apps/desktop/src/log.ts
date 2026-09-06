import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface LogSink {
  write: (chunk: string) => void
  close: () => void
}

export function fileLog(dir: string, name: string): LogSink {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  const write = (chunk: string) => {
    try {
      appendFileSync(path, chunk, 'utf8')
    } catch {
      // A full disk or revoked permission must not take the shell down.
    }
  }
  return { write, close: () => {} }
}
