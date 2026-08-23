import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repositoryRoot = path.resolve(packageRoot, '..', '..')
const overlayPath = path.join(packageRoot, 'cordis.patch.yml')
const packageName = '@themis4226/dsh-official-update-check'
const shutdownToken = '__DSH_OFFICIAL_UPDATE_TEST_SHUTDOWN__\n'

async function findDshEntry() {
  const relative = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const candidates = [
    process.env.DSH_TEST_ENTRY,
    path.join(repositoryRoot, relative),
    path.resolve(repositoryRoot, '..', '..', relative),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  throw new Error('DSH test runtime not found; install dependencies or set DSH_TEST_ENTRY')
}

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

test('real DSH serves the maintainer-only client from its isolated bundle', { timeout: 120_000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-official-update-check-'))
  const dshEntry = await findDshEntry()
  let child
  try {
    const preloadPath = path.join(tempRoot, 'preload.mjs')
    const packageUrl = pathToFileURL(path.join(packageRoot, 'lib', 'index.js')).href
    const manifestUrl = pathToFileURL(path.join(packageRoot, 'package.json')).href
    await writeFile(preloadPath, `
      import { registerHooks } from 'node:module'
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === ${JSON.stringify(packageName)}) {
            return { url: ${JSON.stringify(packageUrl)}, shortCircuit: true }
          }
          if (specifier === ${JSON.stringify(`${packageName}/package.json`)}) {
            return { url: ${JSON.stringify(manifestUrl)}, shortCircuit: true }
          }
          return nextResolve(specifier, context)
        },
      })
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        input += chunk
        if (input.includes(${JSON.stringify(shutdownToken.trim())})) process.emit('SIGTERM')
      })
    `, 'utf8')

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
        env: { ...process.env, DSH_HOME: path.join(tempRoot, '.dsh') },
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
    assert.match(html, /@themis4226\/dsh-official-update-check/)

    const clientResponse = await fetch(
      `http://127.0.0.1:${port}/plugins/@themis4226/dsh-official-update-check/client.js`,
    )
    assert.equal(clientResponse.status, 200)
    const servedClient = await clientResponse.text()
    const sourceClient = await readFile(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
    assert.equal(servedClient, sourceClient)
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
