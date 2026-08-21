import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const workspaceRoot = path.resolve(import.meta.dirname, '..', '..')
const launcherSourcePath = path.join(workspaceRoot, 'launcher', 'DeepSeekHarnessLauncher.cpp')
const integrationRoot = path.join(
  workspaceRoot,
  'launcher-integration',
  'dsh-launcher-update-ui',
)
const overlayPath = path.join(workspaceRoot, 'launcher-integration', 'cordis.patch.yml')
const dshEntry = path.join(
  workspaceRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
)
const shutdownToken = '__DSH_LAUNCHER_SHUTDOWN__\n'

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DSH did not exit in time')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

test('real DSH serves the launcher client while its runtime tree stays untouched', { timeout: 120_000 }, async () => {
  const runtimeCopy = path.join(
    workspaceRoot,
    'node_modules',
    '@themis4226',
    'dsh-launcher-update-ui',
  )
  await assert.rejects(readFile(path.join(runtimeCopy, 'package.json')), { code: 'ENOENT' })

  const launcherSource = await readFile(launcherSourcePath, 'utf8')
  const match = launcherSource.match(
    /constexpr char kShutdownBridge\[\] = R"JS\(([\s\S]*?)\)JS";/,
  )
  assert.notEqual(match, null, 'embedded preload source was not found')

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-runtime-integration-'))
  let child
  try {
    const preloadPath = path.join(tempRoot, 'preload.mjs')
    await writeFile(preloadPath, match[1], 'utf8')
    child = spawn(
      process.execPath,
      [
        `--import=${pathToFileURL(preloadPath).href}`,
        dshEntry,
        'web',
        '--patch',
        overlayPath,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--no-open',
      ],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          DSH_HOME: path.join(tempRoot, '.dsh'),
          DSH_LAUNCHER_INTEGRATION_ROOT: integrationRoot,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    let output = ''
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`DSH startup timed out:\n${output}`)), 90_000)
      const inspect = (chunk) => {
        output += chunk.toString('utf8')
        const ready = output.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
        if (ready !== null) {
          clearTimeout(timeout)
          resolve(Number(ready[1]))
        }
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`DSH exited before ready (${String(code)}):\n${output}`))
      })
    })

    const indexResponse = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(indexResponse.status, 200)
    const html = await indexResponse.text()
    assert.match(html, /@themis4226\/dsh-launcher-update-ui/)

    const clientResponse = await fetch(
      `http://127.0.0.1:${port}/plugins/@themis4226/dsh-launcher-update-ui/client.js`,
    )
    assert.equal(clientResponse.status, 200)
    const servedClient = await clientResponse.text()
    const sourceClient = await readFile(path.join(integrationRoot, 'lib', 'client.js'), 'utf8')
    assert.equal(servedClient, sourceClient)

    await assert.rejects(readFile(path.join(runtimeCopy, 'package.json')), { code: 'ENOENT' })
  } finally {
    if (child !== undefined && child.exitCode === null) {
      child.stdin.write(shutdownToken)
      child.stdin.end()
      try {
        await waitForExit(child, 15_000)
      } catch {
        child.kill()
        await waitForExit(child, 5_000).catch(() => {})
      }
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
})
