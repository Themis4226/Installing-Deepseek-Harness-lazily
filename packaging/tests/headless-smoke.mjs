import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

assert.ok(process.env.DSH_TEST_ENTRY, 'set DSH_TEST_ENTRY to the isolated official runtime')
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-headless-release-smoke-'))
const dshHome = path.join(root, '.dsh')
await mkdir(dshHome)
const requests = []
const toolSteps = [
  { name: 'write', arguments: { file_path: path.join(root, 'smoke.txt'), content: 'launcher-file-ok\n' } },
  { name: 'read', arguments: { file_path: path.join(root, 'smoke.txt') } },
  { name: 'pwsh', arguments: { command: "Write-Output 'launcher-shell-ok'", description: 'Verify isolated PowerShell tool execution' } },
]
const server = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const step = toolSteps[requests.length - 1]
    const delta = step
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-smoke-' + requests.length, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
      : { role: 'assistant', content: 'launcher-smoke-ok' }
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }]) {
      res.write('data: ' + JSON.stringify({ id: 'smoke-response', object: 'chat.completion.chunk', created: 1, model: 'smoke-model', choices: [choice] }) + '\n\n')
    }
    res.end('data: [DONE]\n\n')
  } catch (error) { res.writeHead(500); res.end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await writeFile(path.join(dshHome, 'settings.yaml'), `llm-pi-ai:\n  providers:\n    launcher-smoke:\n      api: openai-completions\n      baseURL: http://127.0.0.1:${port}/v1\n      apiKeyEnv: DSH_SMOKE_KEY\n      models:\n        - id: smoke-model\n          contextWindow: 32768\nagent-default-model:\n  provider: launcher-smoke\n  model: smoke-model\n`)
await writeFile(path.join(root, 'test.patch.yml'), '- id: session-title-llm\n  disabled: true\n')
let child
try {
  child = spawn(process.execPath, [process.env.DSH_TEST_ENTRY, '--profile', 'headless', '--patch', path.join(root, 'test.patch.yml'), 'Perform the local release smoke test.'], { cwd: root, windowsHide: true, env: { ...process.env, DSH_HOME: dshHome, DSH_SMOKE_KEY: 'local-test-placeholder' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => stdout += chunk)
  child.stderr.on('data', chunk => stderr += chunk)
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('headless smoke timeout: ' + stderr)) }, 60000)
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timeout); resolve(code) })
  })
  assert.equal(code, 0, stderr)
  assert.match(stdout, /launcher-smoke-ok/)
  assert.equal(requests.length, 4)
  assert.equal(await readFile(path.join(root, 'smoke.txt'), 'utf8'), 'launcher-file-ok\n')
  const toolResults = requests.at(-1).messages.filter(message => message.role === 'tool')
  assert.equal(toolResults.length, 3)
  assert.match(JSON.stringify(toolResults[1]), /launcher-file-ok/)
  assert.match(JSON.stringify(toolResults[2]), /launcher-shell-ok/)
  console.log(JSON.stringify({ passed: true, requests: requests.length, stdout: stdout.trim(), tools: ['write', 'read', 'pwsh'], realApiRequests: 0 }))
} finally {
  if (child && child.exitCode === null) child.kill()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('dsh-headless-release-smoke-'))
  await rm(root, { recursive: true, force: true })
}
