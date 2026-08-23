import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const packageRoot = path.resolve(import.meta.dirname, '..')
const repositoryRoot = path.resolve(packageRoot, '..', '..')

async function loadClient() {
  const source = await readFile(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
  let descriptor
  const context = {
    window: { __ModuleLoader__: { load(value) { descriptor = value } } },
    globalThis: {},
    AbortController,
    Error,
    JSON,
    Math,
    Number,
    RegExp,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  const React = {
    createElement() {},
    useEffect() {},
    useRef() { return { current: undefined } },
    useState(value) { return [value, () => {}] },
  }
  const plugin = descriptor.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected client dependency: ${id}`)
  })
  return { descriptor, plugin, source }
}

test('manifest is a private DSH bundle with a web client', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const patch = await readFile(path.join(packageRoot, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.name, '@themis4226/dsh-official-update-check')
  assert.equal(manifest.private, true)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.match(patch, /id: official-update-check/)
  assert.match(patch, /name: '@themis4226\/dsh-official-update-check'/)
})

test('client adds a separate row after the existing launcher update row', async () => {
  const { descriptor, plugin } = await loadClient()
  assert.equal(descriptor.id, '@themis4226/dsh-official-update-check')

  const registered = []
  const ctx = {
    effect(callback) { callback() },
    locale: { register() { return () => {} } },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.general.item')
        callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.id, 'official-update-check')
  assert.equal(registered[0].options.order, 110)
  assert.notEqual(registered[0].options.id, 'launcher-update')
  assert.equal(typeof registered[0].component, 'function')
})

test('semver comparison handles release and prerelease ordering', async () => {
  const { plugin } = await loadClient()
  assert.equal(plugin.compareSemver('0.1.1-rc.3', '0.1.1-rc.2'), 1)
  assert.equal(plugin.compareSemver('0.1.1', '0.1.1-rc.9'), 1)
  assert.equal(plugin.compareSemver('0.1.1-rc.2', '0.1.1-rc.2+build.7'), 0)
  assert.equal(plugin.compareSemver('0.1.0', '0.1.1'), -1)
  assert.equal(plugin.compareSemver('latest', '0.1.1'), undefined)
})

test('official lookup accepts only the DeepSeek DSH package and a valid version', async () => {
  const { plugin } = await loadClient()
  let request
  const version = await plugin.readOfficialVersion(async (url, options) => {
    request = { url, options }
    return {
      ok: true,
      status: 200,
      async json() { return { name: '@deepseek-ai/dsh', version: '0.1.1-rc.3' } },
    }
  })
  assert.equal(version, '0.1.1-rc.3')
  assert.equal(request.url, plugin.OFFICIAL_LATEST_URL)
  assert.equal(request.options.credentials, 'omit')
  assert.equal(request.options.redirect, 'error')

  await assert.rejects(
    plugin.readOfficialVersion(async () => ({
      ok: true,
      async json() { return { name: '@example/not-dsh', version: '99.0.0' } },
    })),
    /unexpected npm package metadata/,
  )
})

test('plugin is read-only and does not expose install, publish, or update mutation messages', async () => {
  const { source } = await loadClient()
  assert.match(source, /registry\.npmjs\.org\/@deepseek-ai%2Fdsh\/latest/)
  assert.match(source, /官方更新检查/)
  assert.doesNotMatch(source, /update\.prepare|update\.activate|release\.create|githubToken|npmToken/)
})

test('Lite packaging embeds the public UI and excludes all integration sidecars', async () => {
  const buildLite = await readFile(path.join(repositoryRoot, 'packaging', 'build-lite.ps1'), 'utf8')
  const verifyLite = await readFile(path.join(repositoryRoot, 'packaging', 'verify-lite-stage.mjs'), 'utf8')
  const verifyRuntime = await readFile(path.join(repositoryRoot, 'packaging', 'verify-runtime-package.mjs'), 'utf8')

  assert.match(buildLite, /integrationPackagePath = Join-Path \$integrationPath 'dsh-launcher-update-ui'/)
  assert.doesNotMatch(buildLite, /stageIntegrationPath|stageIntegrationPackage/)
  assert.doesNotMatch(buildLite, /dsh-official-update-check/)
  assert.match(verifyLite, /'launcher-integration'/)
  assert.match(verifyLite, /'dsh-official-update-check'/)
  assert.match(verifyRuntime, /dsh-official-update-check/)
})
