import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const workspaceRoot = path.resolve(import.meta.dirname, '..', '..')
const launcherSourcePath = path.join(workspaceRoot, 'launcher', 'DeepSeekHarnessLauncher.cpp')
const integrationRoot = path.join(
  workspaceRoot,
  'launcher-integration',
  'dsh-launcher-update-ui',
)

test('generated preload resolves the launcher package without touching runtime node_modules', async () => {
  const launcherSource = await readFile(launcherSourcePath, 'utf8')
  const match = launcherSource.match(
    /constexpr char kShutdownBridge\[\] = R"JS\(([\s\S]*?)\)JS";/,
  )
  assert.notEqual(match, null, 'embedded preload source was not found')

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-preload-'))
  try {
    const preloadPath = path.join(tempRoot, 'preload.mjs')
    await writeFile(preloadPath, match[1], 'utf8')

    const probe = String.raw`
      import { createRequire } from 'node:module'
      import { Worker } from 'node:worker_threads'
      const name = '@themis4226/dsh-launcher-update-ui'
      const imported = await import(name)
      const packagePath = createRequire(import.meta.url).resolve(name + '/package.json')
      const workerPackageMapped = await new Promise((resolve, reject) => {
        const workerSource = "import('node:worker_threads').then(({ parentPort }) => import('@themis4226/dsh-launcher-update-ui').then(() => parentPort.postMessage(true)).catch(() => parentPort.postMessage(false)))"
        const worker = new Worker(
          workerSource,
          { eval: true },
        )
        worker.on('message', resolve)
        worker.on('error', reject)
      })
      process.stdout.write(JSON.stringify({
        apply: typeof imported.apply,
        packagePath,
        environmentCleared: process.env.DSH_LAUNCHER_INTEGRATION_ROOT === undefined,
        workerPackageMapped,
      }))
    `
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preloadPath).href, '--input-type=module', '-e', probe],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_LAUNCHER_INTEGRATION_ROOT: integrationRoot,
        },
      },
    )

    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.apply, 'function')
    assert.equal(output.environmentCleared, true)
    assert.equal(output.workerPackageMapped, false)
    assert.equal(path.normalize(output.packagePath), path.join(integrationRoot, 'package.json'))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
