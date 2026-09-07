/**
 * Dev-only probe: verify the desktop bridge from inside the hosted page over
 * the CDP debugging port. Launch the shell with
 * `pnpm --filter @deepseek-ai/dsh-desktop start -- --remote-debugging-port=9223`,
 * then `node scripts/probe-bridge.mjs --port 9223`.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Map(process.argv.slice(2).map((arg, index, all) =>
  arg.startsWith('--') ? [arg.slice(2), all[index + 1]] : [null, null]))
const port = Number(args.get('port') ?? 9223)

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((target) =>
  typeof target.url === 'string' && target.url.startsWith('http://127.0.0.1') && target.type === 'page')
if (page === undefined) {
  console.error(`no loopback page target on CDP port ${port}`)
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolveResult, rejectResult } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) rejectResult(new Error(message.error.message))
    else resolveResult(message.result)
  }
})

function evaluate(expression) {
  return new Promise((resolveResult, rejectResult) => {
    const id = ++nextId
    pending.set(id, { resolveResult, rejectResult })
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }))
  }).then((result) => {
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? 'evaluation exception')
    }
    return result.result.value
  })
}

const steps = [
  ['bridge present', `(() => {
    const bridge = window.desktopBridge
    return { present: typeof bridge === 'object' && bridge !== null,
             methods: bridge ? Object.keys(bridge).sort() : [] }
  })()`],
  ['windowState', 'window.desktopBridge.windowState()'],
  ['notify', `window.desktopBridge.notify({
    title: 'Desktop bridge probe',
    body: 'P2.1 acceptance: notify over the real preload bridge',
    urgency: 'normal'
  })`],
  ['flash duration', 'window.desktopBridge.flash({ kind: "duration", ms: 800 }).then(() => "ok")'],
  ['flashClear', 'window.desktopBridge.flashClear().then(() => "ok")'],
]

let failed = false
for (const [name, expression] of steps) {
  try {
    const value = await evaluate(expression)
    console.log(`[ok] ${name}: ${JSON.stringify(value)}`)
  } catch (error) {
    failed = true
    console.error(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

socket.close()
process.exit(failed ? 1 : 0)