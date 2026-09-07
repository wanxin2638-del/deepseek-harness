/**
 * Copy the sandboxed renderer preload into lib/. tsc only emits TypeScript;
 * the preload must stay CommonJS (Electron sandboxed preloads cannot use ESM)
 * and is therefore authored as src/preload.cjs.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const outDir = resolve(appRoot, 'lib')
mkdirSync(outDir, { recursive: true })
copyFileSync(resolve(appRoot, 'src', 'preload.cjs'), resolve(outDir, 'preload.cjs'))