import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  FIXED_LAUNCHER_FILE,
  FIXED_RUNTIME_ENTRY,
  UpdaterError,
  checkForBundle,
  checkForUpdate,
  compareSemver,
  parseCliArguments,
  prepareLauncher,
  prepareRuntime,
  validateArchiveEntryNames,
  validateLauncherManifest,
  validateManifest,
} from '../updater.mjs'

const execFileAsync = promisify(execFile)
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const UPDATER_PATH = path.resolve(TEST_DIRECTORY, '..', 'updater.mjs')
const TAR_PATH =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
const REMOTE_VERSION = '0.1.1-rc.2'
const CURRENT_VERSION = '0.1.1-rc.1'
const REMOTE_LAUNCHER_VERSION = '1.4.1'
const CURRENT_LAUNCHER_VERSION = '1.4.0'

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  crcTable[index] = value >>> 0
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

async function createStoredZip(zipPath, entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents ?? '', 'utf8')
    const checksum = crc32(contents)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(contents.length, 18)
    local.writeUInt32LE(contents.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, contents)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(contents.length, 20)
    central.writeUInt32LE(contents.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    const unixMode = entry.unixMode ?? 0o100644
    central.writeUInt32LE((unixMode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + contents.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  await writeFile(zipPath, Buffer.concat([...localParts, centralDirectory, end]))
}

function runtimeMetadata(version = REMOTE_VERSION) {
  return JSON.stringify({
    schemaVersion: 1,
    dshPackage: '@deepseek-ai/dsh',
    dshVersion: version,
    platform: 'win32',
    arch: 'x64',
    entry: FIXED_RUNTIME_ENTRY,
  })
}

function goodRuntimeEntries(version = REMOTE_VERSION) {
  return [
    { name: 'runtime/runtime.json', contents: runtimeMetadata(version) },
    {
      name: 'runtime/node_modules/@deepseek-ai/dsh/package.json',
      contents: JSON.stringify({ name: '@deepseek-ai/dsh', version }),
    },
    {
      name: `runtime/${FIXED_RUNTIME_ENTRY}`,
      contents: '#!/usr/bin/env node\nconsole.log("fixture")\n',
    },
  ]
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

function minimalAmd64Pe() {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x00004550, 0x80)
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(0x020b, 0x98)
  return bytes
}

async function makeManifest(assetPath, changes = {}) {
  const assetStats = await stat(assetPath)
  const value = {
    schemaVersion: 1,
    channel: 'preview',
    publishedAt: '2026-08-21T15:00:00Z',
    minimumLauncherVersion: '1.2.0',
    runtime: {
      version: REMOTE_VERSION,
      platform: 'win32',
      arch: 'x64',
      format: 'dsh-runtime-zip-v1',
      asset: {
        url: pathToFileURL(assetPath).href,
        size: assetStats.size,
        sha256: await sha256(assetPath),
      },
    },
    releaseNotesUrl: 'https://example.invalid/runtime-v0.1.1-rc.2',
  }
  if (changes.top) Object.assign(value, changes.top)
  if (changes.runtime) Object.assign(value.runtime, changes.runtime)
  if (changes.asset) Object.assign(value.runtime.asset, changes.asset)
  return value
}

async function makeLauncherManifest(assetPath, changes = {}) {
  const assetStats = await stat(assetPath)
  const value = {
    schemaVersion: 1,
    channel: 'preview',
    publishedAt: '2026-08-24T15:00:00Z',
    launcher: {
      version: REMOTE_LAUNCHER_VERSION,
      platform: 'win32',
      arch: 'x64',
      format: 'portable-exe-v1',
      asset: {
        url: pathToFileURL(assetPath).href,
        size: assetStats.size,
        sha256: await sha256(assetPath),
      },
    },
    releaseNotesUrl: 'https://example.invalid/launcher-v1.4.1',
  }
  if (changes.top) Object.assign(value, changes.top)
  if (changes.launcher) Object.assign(value.launcher, changes.launcher)
  if (changes.asset) Object.assign(value.launcher.asset, changes.asset)
  return value
}

async function makeFixture(t, entries = goodRuntimeEntries()) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-updater-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assetPath = path.join(root, 'runtime.zip')
  const manifestPath = path.join(root, 'update.json')
  const launcherAssetPath = path.join(root, 'DeepSeek-Harness.exe')
  const launcherManifestPath = path.join(root, 'launcher-update.json')
  const dataRoot = path.join(root, 'launcher-data')
  await createStoredZip(assetPath, entries)
  await writeFile(launcherAssetPath, minimalAmd64Pe())
  const manifest = await makeManifest(assetPath)
  const launcherManifest = await makeLauncherManifest(launcherAssetPath)
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
  await writeFile(launcherManifestPath, JSON.stringify(launcherManifest), 'utf8')
  return {
    root,
    assetPath,
    manifest,
    manifestPath,
    manifestUrl: pathToFileURL(manifestPath).href,
    launcherAssetPath,
    launcherManifest,
    launcherManifestPath,
    launcherManifestUrl: pathToFileURL(launcherManifestPath).href,
    dataRoot,
  }
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function assertUpdaterCode(code) {
  return (error) => error instanceof UpdaterError && error.code === code
}

test('semantic version comparison handles release candidates numerically', () => {
  assert.equal(compareSemver('0.1.1-rc.2', '0.1.1-rc.1'), 1)
  assert.equal(compareSemver('0.1.1-rc.10', '0.1.1-rc.2'), 1)
  assert.equal(compareSemver('0.1.1', '0.1.1-rc.99'), 1)
  assert.equal(compareSemver('0.1.1+build.2', '0.1.1+build.1'), 0)
})

test('manifest validation is strict about schema and runtime identity', async (t) => {
  const fixture = await makeFixture(t)
  assert.equal(validateManifest(fixture.manifest, { testMode: true }).runtime.version, REMOTE_VERSION)

  const unknown = structuredClone(fixture.manifest)
  unknown.unexpected = true
  assert.throws(() => validateManifest(unknown, { testMode: true }), assertUpdaterCode('SCHEMA_INVALID'))

  const platform = structuredClone(fixture.manifest)
  platform.runtime.platform = 'linux'
  assert.throws(() => validateManifest(platform, { testMode: true }), assertUpdaterCode('PLATFORM_MISMATCH'))

  const architecture = structuredClone(fixture.manifest)
  architecture.runtime.arch = 'arm64'
  assert.throws(() => validateManifest(architecture, { testMode: true }), assertUpdaterCode('ARCH_MISMATCH'))

  const format = structuredClone(fixture.manifest)
  format.runtime.format = 'zip'
  assert.throws(() => validateManifest(format, { testMode: true }), assertUpdaterCode('FORMAT_MISMATCH'))

  const version = structuredClone(fixture.manifest)
  version.runtime.version = 'v0.1.1'
  assert.throws(() => validateManifest(version, { testMode: true }), assertUpdaterCode('VERSION_INVALID'))

  const size = structuredClone(fixture.manifest)
  size.runtime.asset.size = 0
  assert.throws(() => validateManifest(size, { testMode: true }), assertUpdaterCode('SCHEMA_INVALID'))

  const hash = structuredClone(fixture.manifest)
  hash.runtime.asset.sha256 = 'abc'
  assert.throws(() => validateManifest(hash, { testMode: true }), assertUpdaterCode('SCHEMA_INVALID'))
})

test('launcher manifest validation is strict about schema and launcher identity', async (t) => {
  const fixture = await makeFixture(t)
  const validated = validateLauncherManifest(fixture.launcherManifest, { testMode: true })
  assert.equal(validated.launcher.version, REMOTE_LAUNCHER_VERSION)
  assert.equal(validated.launcher.asset.sha256, fixture.launcherManifest.launcher.asset.sha256)

  const unknown = structuredClone(fixture.launcherManifest)
  unknown.unexpected = true
  assert.throws(
    () => validateLauncherManifest(unknown, { testMode: true }),
    assertUpdaterCode('SCHEMA_INVALID'),
  )

  const nestedUnknown = structuredClone(fixture.launcherManifest)
  nestedUnknown.launcher.asset.signature = 'not-allowed'
  assert.throws(
    () => validateLauncherManifest(nestedUnknown, { testMode: true }),
    assertUpdaterCode('SCHEMA_INVALID'),
  )

  const platform = structuredClone(fixture.launcherManifest)
  platform.launcher.platform = 'linux'
  assert.throws(
    () => validateLauncherManifest(platform, { testMode: true }),
    assertUpdaterCode('PLATFORM_MISMATCH'),
  )

  const architecture = structuredClone(fixture.launcherManifest)
  architecture.launcher.arch = 'arm64'
  assert.throws(
    () => validateLauncherManifest(architecture, { testMode: true }),
    assertUpdaterCode('ARCH_MISMATCH'),
  )

  const format = structuredClone(fixture.launcherManifest)
  format.launcher.format = 'msi'
  assert.throws(
    () => validateLauncherManifest(format, { testMode: true }),
    assertUpdaterCode('FORMAT_MISMATCH'),
  )

  const version = structuredClone(fixture.launcherManifest)
  version.launcher.version = 'v1.4.1'
  assert.throws(
    () => validateLauncherManifest(version, { testMode: true }),
    assertUpdaterCode('VERSION_INVALID'),
  )

  const size = structuredClone(fixture.launcherManifest)
  size.launcher.asset.size = 0
  assert.throws(
    () => validateLauncherManifest(size, { testMode: true }),
    assertUpdaterCode('SCHEMA_INVALID'),
  )

  const hash = structuredClone(fixture.launcherManifest)
  hash.launcher.asset.sha256 = 'abc'
  assert.throws(
    () => validateLauncherManifest(hash, { testMode: true }),
    assertUpdaterCode('SCHEMA_INVALID'),
  )
})

test('CLI arguments have one fixed check or prepare shape', async (t) => {
  const fixture = await makeFixture(t)
  const parsed = parseCliArguments([
    'check',
    '--manifest',
    fixture.manifestUrl,
    '--data-root',
    fixture.dataRoot,
    '--current-version',
    CURRENT_VERSION,
    '--test-mode',
  ])
  assert.equal(parsed.command, 'check')
  assert.equal(parsed.testMode, true)
  assert.throws(
    () => parseCliArguments(['check', '--manifest', fixture.manifestUrl]),
    assertUpdaterCode('CLI_INVALID'),
  )
})

test('bundle CLI arguments require both fixed manifests and both current versions', async (t) => {
  const fixture = await makeFixture(t)
  const parsed = parseCliArguments([
    'check-bundle',
    '--manifest',
    fixture.manifestUrl,
    '--launcher-manifest',
    fixture.launcherManifestUrl,
    '--data-root',
    fixture.dataRoot,
    '--current-version',
    CURRENT_VERSION,
    '--current-launcher-version',
    CURRENT_LAUNCHER_VERSION,
    '--test-mode',
  ])
  assert.equal(parsed.command, 'check-bundle')
  assert.equal(parsed.launcherManifestUrl, fixture.launcherManifestUrl)
  assert.equal(parsed.currentLauncherVersion, CURRENT_LAUNCHER_VERSION)
  assert.equal(parsed.testMode, true)

  assert.throws(
    () =>
      parseCliArguments([
        'check-bundle',
        '--manifest',
        fixture.manifestUrl,
        '--data-root',
        fixture.dataRoot,
        '--current-version',
        CURRENT_VERSION,
        '--current-launcher-version',
        CURRENT_LAUNCHER_VERSION,
      ]),
    assertUpdaterCode('CLI_INVALID'),
  )
  assert.throws(
    () =>
      parseCliArguments([
        'check',
        '--manifest',
        fixture.manifestUrl,
        '--launcher-manifest',
        fixture.launcherManifestUrl,
        '--data-root',
        fixture.dataRoot,
        '--current-version',
        CURRENT_VERSION,
      ]),
    assertUpdaterCode('CLI_INVALID'),
  )
})

test('bundle check distinguishes all four update states', async (t) => {
  const fixture = await makeFixture(t)
  const cases = [
    {
      status: 'up-to-date',
      currentVersion: REMOTE_VERSION,
      currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
      launcherVersion: CURRENT_LAUNCHER_VERSION,
      minimumLauncherVersion: '1.2.0',
      runtimeUpdateAvailable: false,
      launcherUpdateAvailable: false,
    },
    {
      status: 'update-available',
      currentVersion: CURRENT_VERSION,
      currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
      launcherVersion: CURRENT_LAUNCHER_VERSION,
      minimumLauncherVersion: '1.2.0',
      runtimeUpdateAvailable: true,
      launcherUpdateAvailable: false,
    },
    {
      status: 'launcher-update-available',
      currentVersion: REMOTE_VERSION,
      currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
      launcherVersion: REMOTE_LAUNCHER_VERSION,
      minimumLauncherVersion: '1.2.0',
      runtimeUpdateAvailable: false,
      launcherUpdateAvailable: true,
    },
    {
      status: 'release-incomplete',
      currentVersion: CURRENT_VERSION,
      currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
      launcherVersion: REMOTE_LAUNCHER_VERSION,
      minimumLauncherVersion: '1.5.0',
      runtimeUpdateAvailable: true,
      launcherUpdateAvailable: true,
    },
  ]

  for (const scenario of cases) {
    fixture.manifest.minimumLauncherVersion = scenario.minimumLauncherVersion
    fixture.launcherManifest.launcher.version = scenario.launcherVersion
    await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), 'utf8')
    await writeFile(
      fixture.launcherManifestPath,
      JSON.stringify(fixture.launcherManifest),
      'utf8',
    )
    const checked = await checkForBundle({
      manifestUrl: fixture.manifestUrl,
      launcherManifestUrl: fixture.launcherManifestUrl,
      currentVersion: scenario.currentVersion,
      currentLauncherVersion: scenario.currentLauncherVersion,
      testMode: true,
    })
    assert.equal(checked.status, scenario.status, scenario.status)
    assert.equal(
      checked.runtimeUpdateAvailable,
      scenario.runtimeUpdateAvailable,
      `${scenario.status}: runtime availability`,
    )
    assert.equal(
      checked.launcherUpdateAvailable,
      scenario.launcherUpdateAvailable,
      `${scenario.status}: launcher availability`,
    )
  }
})

test('check and prepare install a valid immutable runtime without active state', async (t) => {
  const fixture = await makeFixture(t)
  const checked = await checkForUpdate({
    manifestUrl: fixture.manifestUrl,
    currentVersion: CURRENT_VERSION,
    testMode: true,
  })
  assert.equal(checked.status, 'update-available')
  assert.equal(checked.size, fixture.manifest.runtime.asset.size)
  assert.equal(checked.sha256, fixture.manifest.runtime.asset.sha256)

  const prepared = await prepareRuntime({
    manifestUrl: fixture.manifestUrl,
    dataRoot: fixture.dataRoot,
    currentVersion: CURRENT_VERSION,
    testMode: true,
    tarPath: TAR_PATH,
  })
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.version, REMOTE_VERSION)
  assert.equal(
    await readFile(path.join(prepared.runtimePath, ...FIXED_RUNTIME_ENTRY.split('/')), 'utf8'),
    '#!/usr/bin/env node\nconsole.log("fixture")\n',
  )
  assert.equal(await exists(path.join(fixture.dataRoot, 'state.txt')), false)
  assert.equal(await exists(path.join(fixture.dataRoot, 'updates', 'state.txt')), false)
  assert.equal(await exists(path.join(fixture.dataRoot, 'active.json')), false)

  const repeated = await prepareRuntime({
    manifestUrl: fixture.manifestUrl,
    dataRoot: fixture.dataRoot,
    currentVersion: CURRENT_VERSION,
    testMode: true,
    tarPath: TAR_PATH,
  })
  assert.equal(repeated.status, 'already-prepared')
})

test('prepare rejects a bad SHA256 without installing a runtime', async (t) => {
  const fixture = await makeFixture(t)
  fixture.manifest.runtime.asset.sha256 = '0'.repeat(64)
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), 'utf8')
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('HASH_MISMATCH'),
  )
  assert.equal(await exists(path.join(fixture.dataRoot, 'runtimes', REMOTE_VERSION)), false)
})

test('prepare rejects a bad declared size without installing a runtime', async (t) => {
  const fixture = await makeFixture(t)
  fixture.manifest.runtime.asset.size += 1
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), 'utf8')
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('SIZE_MISMATCH'),
  )
  assert.equal(await exists(path.join(fixture.dataRoot, 'runtimes', REMOTE_VERSION)), false)
})

test('prepare launcher installs one validated immutable AMD64 executable', async (t) => {
  const fixture = await makeFixture(t)
  const prepared = await prepareLauncher({
    launcherManifestUrl: fixture.launcherManifestUrl,
    dataRoot: fixture.dataRoot,
    currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
    testMode: true,
  })
  assert.equal(prepared.status, 'launcher-prepared')
  assert.equal(prepared.launcherVersion, REMOTE_LAUNCHER_VERSION)
  assert.equal(path.basename(prepared.launcherPath), FIXED_LAUNCHER_FILE)
  assert.deepEqual(await readFile(prepared.launcherPath), await readFile(fixture.launcherAssetPath))
  assert.equal(await exists(path.join(fixture.dataRoot, 'active.json')), false)

  const repeated = await prepareLauncher({
    launcherManifestUrl: fixture.launcherManifestUrl,
    dataRoot: fixture.dataRoot,
    currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
    testMode: true,
  })
  assert.equal(repeated.status, 'launcher-already-prepared')
  assert.equal(repeated.launcherPath, prepared.launcherPath)
})

test('prepare launcher rejects a bad SHA256 without installing a candidate', async (t) => {
  const fixture = await makeFixture(t)
  fixture.launcherManifest.launcher.asset.sha256 = '0'.repeat(64)
  await writeFile(
    fixture.launcherManifestPath,
    JSON.stringify(fixture.launcherManifest),
    'utf8',
  )
  await assert.rejects(
    prepareLauncher({
      launcherManifestUrl: fixture.launcherManifestUrl,
      dataRoot: fixture.dataRoot,
      currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
      testMode: true,
    }),
    assertUpdaterCode('HASH_MISMATCH'),
  )
  assert.equal(
    await exists(
      path.join(
        fixture.dataRoot,
        'updates',
        'launchers',
        REMOTE_LAUNCHER_VERSION,
        FIXED_LAUNCHER_FILE,
      ),
    ),
    false,
  )
})

test('prepare launcher rejects a correctly hashed non-PE file', async (t) => {
  const fixture = await makeFixture(t)
  await writeFile(fixture.launcherAssetPath, Buffer.alloc(128, 0x41))
  fixture.launcherManifest = await makeLauncherManifest(fixture.launcherAssetPath)
  await writeFile(
    fixture.launcherManifestPath,
    JSON.stringify(fixture.launcherManifest),
    'utf8',
  )
  await assert.rejects(
    prepareLauncher({
      launcherManifestUrl: fixture.launcherManifestUrl,
      dataRoot: fixture.dataRoot,
      currentLauncherVersion: CURRENT_LAUNCHER_VERSION,
      testMode: true,
    }),
    assertUpdaterCode('LAUNCHER_INVALID'),
  )
  assert.equal(
    await exists(path.join(fixture.dataRoot, 'updates', 'launchers', REMOTE_LAUNCHER_VERSION)),
    false,
  )
})

test('path traversal entries are rejected before extraction', async (t) => {
  const fixture = await makeFixture(t, [
    ...goodRuntimeEntries(),
    { name: '../escape.txt', contents: 'must not escape' },
  ])
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('ARCHIVE_ENTRY_INVALID'),
  )
  assert.equal(await exists(path.join(fixture.root, 'escape.txt')), false)
  assert.equal(await exists(path.join(fixture.dataRoot, 'escape.txt')), false)
  assert.throws(
    () => validateArchiveEntryNames(['runtime/runtime.json', 'runtime/../escape.txt']),
    assertUpdaterCode('ARCHIVE_ENTRY_INVALID'),
  )
})

test('archive links are rejected before extraction', async (t) => {
  const fixture = await makeFixture(t, [
    ...goodRuntimeEntries(),
    {
      name: 'runtime/node_modules/unsafe-link',
      contents: '../outside',
      unixMode: 0o120777,
    },
  ])
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('ARCHIVE_LINK_NOT_ALLOWED'),
  )
})

test('unexpected runtime entries and launcher-only packages are rejected', async (t) => {
  const forbiddenEntries = [
    'runtime/unexpected.txt',
    'runtime/node_modules/@themis4226/dsh-launcher-update-ui/package.json',
    'runtime/node_modules/@themis4226/dsh-official-update-check/package.json',
  ]
  for (const name of forbiddenEntries) {
    const fixture = await makeFixture(t, [
      ...goodRuntimeEntries(),
      { name, contents: '{}' },
    ])
    await assert.rejects(
      prepareRuntime({
        manifestUrl: fixture.manifestUrl,
        dataRoot: fixture.dataRoot,
        currentVersion: CURRENT_VERSION,
        testMode: true,
        tarPath: TAR_PATH,
      }),
      assertUpdaterCode('ARCHIVE_ENTRY_INVALID'),
      name,
    )
    assert.equal(await exists(path.join(fixture.dataRoot, 'runtimes', REMOTE_VERSION)), false)
  }
})

test('prepare CLI writes exactly one JSON line on stdout', async (t) => {
  const fixture = await makeFixture(t)
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      UPDATER_PATH,
      'prepare',
      '--manifest',
      fixture.manifestUrl,
      '--data-root',
      fixture.dataRoot,
      '--current-version',
      CURRENT_VERSION,
      '--test-mode',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  assert.equal(stderr, '')
  const lines = stdout.trimEnd().split(/\r?\n/)
  assert.equal(lines.length, 1)
  const result = JSON.parse(lines[0])
  assert.equal(result.ok, true)
  assert.equal(result.command, 'prepare')
  assert.equal(result.status, 'prepared')
  assert.equal(result.version, REMOTE_VERSION)
})

test('prepare-bundle CLI writes one allowlisted JSON result for runtime and launcher', async (t) => {
  const fixture = await makeFixture(t)
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      UPDATER_PATH,
      'prepare-bundle',
      '--manifest',
      fixture.manifestUrl,
      '--launcher-manifest',
      fixture.launcherManifestUrl,
      '--data-root',
      fixture.dataRoot,
      '--current-version',
      CURRENT_VERSION,
      '--current-launcher-version',
      CURRENT_LAUNCHER_VERSION,
      '--test-mode',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  assert.equal(stderr, '')
  const lines = stdout.trimEnd().split(/\r?\n/)
  assert.equal(lines.length, 1)
  const result = JSON.parse(lines[0])
  assert.equal(result.ok, true)
  assert.equal(result.command, 'prepare-bundle')
  assert.equal(result.status, 'bundle-prepared')
  assert.equal(result.runtimeVersion, REMOTE_VERSION)
  assert.equal(result.launcherVersion, REMOTE_LAUNCHER_VERSION)
  assert.equal(path.basename(result.launcherPath), FIXED_LAUNCHER_FILE)
  assert.equal(Object.hasOwn(result, 'runtimeManifest'), false)
  assert.equal(Object.hasOwn(result, 'launcherManifest'), false)
})
