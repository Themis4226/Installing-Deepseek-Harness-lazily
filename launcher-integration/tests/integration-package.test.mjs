import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const integrationRoot = path.resolve(import.meta.dirname, '..')
const packageRoot = path.join(integrationRoot, 'dsh-launcher-update-ui')
const launcherSourcePath = path.resolve(integrationRoot, '..', 'launcher', 'DeepSeekHarnessLauncher.cpp')

test('package declares a web client and the launcher overlay mounts it', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const overlay = await readFile(path.join(integrationRoot, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.name, '@themis4226/dsh-launcher-update-ui')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.match(overlay, /id: launcher-update-ui/)
  assert.match(overlay, /name: '@themis4226\/dsh-launcher-update-ui'/)
})

test('client bundle registers one additive General-settings row', async () => {
  const source = await readFile(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
  let descriptor
  const messages = []
  const context = {
    window: { __ModuleLoader__: { load(value) { descriptor = value } } },
    globalThis: {
      chrome: {
        webview: {
          addEventListener() {},
          postMessage(value) { messages.push(value) },
        },
      },
    },
    Set,
    JSON,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  assert.equal(descriptor.id, '@themis4226/dsh-launcher-update-ui')

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

  const injected = []
  const registered = []
  const ctx = {
    effect(callback) { callback() },
    locale: { register() { return () => {} } },
    slots: {
      inject(name, callback) {
        injected.push(name)
        callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  assert.deepEqual(messages, ['dsh-launcher:v1:hello'])
  assert.deepEqual(injected, ['settings.general.item'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.general.item')
  assert.equal(registered[0].options.id, 'launcher-update')
  assert.equal(registered[0].options.order, 100)
  assert.equal(typeof registered[0].component, 'function')
})

test('client sends the health hello without mounting or opening the settings row', async () => {
  const source = await readFile(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
  let descriptor
  const messages = []
  const context = {
    window: { __ModuleLoader__: { load(value) { descriptor = value } } },
    globalThis: {
      chrome: {
        webview: {
          addEventListener() {},
          postMessage(value) { messages.push(value) },
        },
      },
    },
    Set,
    JSON,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  const React = {
    createElement() { throw new Error('settings row must not render') },
    useEffect() { throw new Error('settings row must not mount') },
    useRef() { throw new Error('settings row must not mount') },
    useState() { throw new Error('settings row must not mount') },
  }
  const plugin = descriptor.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected client dependency: ${id}`)
  })
  const ctx = {
    effect(callback) { callback() },
    locale: { register() { return () => {} } },
    slots: {
      inject() {},
    },
  }

  plugin.apply(ctx)

  assert.deepEqual(messages, ['dsh-launcher:v1:hello'])
})

test('browser half exposes only handshake and check messages', async () => {
  const source = await readFile(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
  assert.match(source, /dsh-launcher:v1:hello/)
  assert.match(source, /dsh-launcher:v1:update\.check/)
  assert.doesNotMatch(source, /update\.prepare|rollback|manifestUrl|sha256|releaseUrl/)
})

test('native integration keeps the runtime immutable and exposes no top Help menu', async () => {
  const source = await readFile(launcherSourcePath, 'utf8')
  assert.match(source, /registerHooks/)
  assert.match(source, /DSH_LAUNCHER_INTEGRATION_ROOT/)
  assert.match(source, /BuildChildEnvironment/)
  assert.doesNotMatch(source, /copy_file|kLauncherIntegrationRuntimePackageRelativePath/)
  assert.doesNotMatch(source, /SetEnvironmentVariableW/)
  assert.doesNotMatch(source, /g_mainMenu|kCheckUpdateMenuId|L"帮助"/)
})
