const args = new Map(process.argv.slice(2).map((arg, index, all) =>
  arg.startsWith('--') ? [arg.slice(2), all[index + 1]] : [null, null]))
const port = Number(args.get('port') ?? 9223)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((target) => typeof target.url === 'string' && target.url.startsWith('http://127.0.0.1') && target.type === 'page')
if (page === undefined) { console.error('no page target'); process.exit(1) }
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => { const m = JSON.parse(String(event.data)); if (m.id !== undefined && pending.has(m.id)) { const { r } = pending.get(m.id); pending.delete(m.id); r(m.result) } })
function evaluate(expression) { return new Promise((r) => { const id = ++nextId; pending.set(id, { r }); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })) }).then((x) => x.result.value) }
const out = await evaluate(`(() => {
  const boot = window.__DSH_BOOT__
  const entries = boot.entries
  const rows = Array.isArray(entries) ? entries : Object.values(entries || {})
  return rows.map(r => r && (r.id || r.name || r.module || typeof r === 'string' ? (typeof r === 'string' ? r : r.id || r.name || r.module) : String(r))).slice(0, 200)
})()`)
console.log(JSON.stringify(out, null, 2))
socket.close(); process.exit(0)